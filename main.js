const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const { createCaptureRegion } = require('./capture');

// Timestamped logging — makes separate gestures distinguishable in the log,
// which mattered a lot while debugging the hotkey release path.
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// TEMPORARY: placeholder window from Step 1. No longer wired to the hotkey
// (the real Selection Overlay below now owns that job) — likely becomes the
// basis for the Chat Panel at Step 5.
let win;
let overlayWindow;
let captureRegion;

// Which display the current/most recent gesture's overlay was shown on —
// set once at activation (screen.getDisplayNearestPoint, already computed
// fresh there) and read at finalize time by captureRegion(). Re-deriving
// "which display" a second time at finalize, instead of threading this
// through, would risk disagreeing with activation's answer if the cursor
// moved off that display mid-drag — see decisions.md.
let activeDisplayId = null;

function createWindow() {
  win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile('index.html');
}

// Initial bounds only — the overlay is repositioned to the cursor's display
// on every activation (see registerHotkey). The primary display is just a
// sensible starting position for a window that is never shown until then.
// Still one window, not one per display: full simultaneous multi-monitor
// rendering remains out of scope (see decisions.md).
function createOverlayWindow() {
  const { x, y, width, height } = screen.getPrimaryDisplay().bounds;

  overlayWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // macOS runs a separate Space per display by default ("Displays have
  // separate Spaces"). Without this, an overlay moved to the secondary
  // display renders and receives mouse events but never becomes the *key*
  // window: `app.focus({steal:true})` activates the app and macOS gives key
  // status to a window on the currently active Space — which is the other
  // display's, where the Step 1 placeholder window still lives. Symptom was
  // a trail that drew normally and then died at the 2.5s no-key-event
  // deadline while the user was still holding.
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  overlayWindow.loadFile('overlay.html');
}

// INTERIM value — ergonomically poor (3 keys, the same one-handed problem
// that got Cmd+Shift+Space replaced), but empirically verified: Space's
// keyup is delivered reliably here. Replaces Alt+Space, which was silently
// broken — macOS routes Option+<key> through the text-input/composition
// layer (Option is the special-character modifier; Option+Space emits
// U+00A0), which swallowed Space's key events entirely before they reached
// the overlay. Picking a 2-key non-Option replacement is a separate open
// task; see decisions.md and todo.md.
// Chosen accelerator, after testing seven candidates empirically (2026-08-21).
// The list shape is retained because each entry must carry its own trigger
// key `code`, handed to the overlay on activation so the renderer always
// waits on the right keyup.
//
// Control+1 won on measurement: 11 of 11 activations, Digit1's keyup
// delivered every time, zero force-closes. Two keys, comfortable left-hand
// reach, and Ctrl+<digit> is free on macOS since apps bind Cmd+<digit>.
//
// Ruled out empirically — every one of these registered successfully and
// still failed, which is why registration success is worthless as a test:
//   Alt+Space        — Option routes through the text-input/composition
//                      layer; Space's events never arrive at all.
//   F6 (bare F-key)  — macOS consumes it for Do Not Disturb; callback never
//                      fires. Likely true of every bare F-key on a MacBook.
//   Control+`        — registers, callback never fires; the accelerator
//                      string appears not to map to the physical key.
//   Control+Space    — fires, but macOS's input-source switcher grabs the
//                      chord too (visible as an `IMKCFRunLoopWakeUpReliable`
//                      error) and swallows Space's key events. Same class of
//                      failure as Option.
//   Shift+Escape     — works reliably in software; replaced only because
//                      Control+1 is at least as good with no caveats.
//   Control+Shift+Space, Control+Shift+D — both work, both three keys.
//
// NOT tried, deliberately: Shift+Tab. It is the universal reverse-focus
// navigation shortcut in every browser, form, dialog, and editor — grabbing
// it globally would break a fundamental interaction system-wide.
//
// Usability constraint that applies to ANY chord here: macOS only matches a
// global accelerator when the modifier is already down, so the modifier must
// be pressed slightly *before* the trigger key. Pressing both simultaneously
// often fails to activate. This is a property of OS-level hotkey matching,
// not of any particular chord.
//
// Already ruled out empirically: Alt+Space (Option interception), F6 (macOS
// consumes bare F-keys for hardware functions before Electron sees them),
// Control+` (registers, but the callback never fires — the accelerator
// string appears not to map to the physical key on macOS).
const ACCELERATOR_CANDIDATES = [
  { accelerator: 'Control+1', triggerKeyCode: 'Digit1' },
];

// globalShortcut.unregister() returning in JS doesn't guarantee the OS event
// pipeline has released the accelerator's keys yet. Originally added on the
// theory that this explained the quick-tap failures — it did not (see
// decisions.md). Kept only because every verified-working run so far has
// included it, so removing it is an untested change; now that gestures
// resolve reliably there's finally a baseline to test removal against.
const UNREGISTER_SETTLE_MS = 50;

// Liveness watchdog: fires when the trigger key goes *silent* for this long,
// not when the gesture exceeds this duration. A held key auto-repeats
// keydowns every ~80ms, so an in-progress hold keeps re-arming this
// indefinitely and can never be truncated — which is exactly what the
// earlier fixed-deadline version did to genuine 5s+ holds (4 observed across
// runs C and D). It still force-closes a truly stuck gesture, so the
// original guarantee — no permanent hang, no hotkey stranded unregistered —
// is unchanged.
//
// Known limitation: if the user has macOS key repeat set to Off, no repeat
// keydowns arrive and this degrades to the old fixed-deadline behavior.
const STUCK_GESTURE_TIMEOUT_MS = 5000;

// Bounds the ENTIRE captureRegion() call (found during Step 4 self-review,
// 2026-08-22): capture.js's own CAPTURE_TIMEOUT_MS only covers the renderer
// round-trip inside it, not the permission check or desktopCapturer.getSources()
// before it. Without this, a hang in either would leave the hotkey
// unregistered indefinitely — the exact "stuck, unregistered hotkey" failure
// class STUCK_GESTURE_TIMEOUT_MS above already exists to eliminate, just for
// the hold-gesture phase instead of the post-finalize capture phase. Reusing
// that constant's value here rather than inventing a fresh unexplained
// number, plus a margin for the getSources()/permission-check step that
// isn't otherwise bounded by capture.js's own internal timeout.
const CAPTURE_OVERALL_TIMEOUT_MS = STUCK_GESTURE_TIMEOUT_MS + 2000;

// Separate, shorter deadline for the *first* trigger-key event of a gesture.
//
// globalShortcut consumes the trigger key's original keydown to fire the
// accelerator, so the overlay never receives it. The window stays blind to
// the key until macOS's auto-repeat starts (~445ms on default settings,
// measured consistently across gestures) — and a key the window never saw
// also yields no keyup. So releasing before auto-repeat begins leaves the
// gesture with no way to end, hanging until the watchdog. That's the
// long-standing "quick tap" bug, and because the accelerator is unregistered
// for the whole hang, every hotkey press during it is silently dead too.
//
// 2.5s, deliberately not the ~1.2s that would feel snappier: macOS's "Delay
// Until Repeat" can be set as slow as ~2s, and that setting exists for
// accessibility/motor reasons. A tighter deadline would force-cancel genuine
// holds for exactly the users who need that setting — the same class of
// silent truncation the liveness watchdog was built to eliminate. 2.5s sits
// above the worst-case repeat delay, so it cannot produce that failure at any
// configuration, while still cutting a dead 5s window roughly in half.
//
// Deferred alternative: read the user's actual repeat delay
// (`defaults read -g InitialKeyRepeat`) and derive this. More precise, but
// real complexity — shelling out, unit conversion, a fallback path — for a
// Phase 1 prototype. Not worth building yet; revisit if the fixed value
// causes trouble.
const INITIAL_KEY_DEADLINE_MS = 2500;

let stuckGestureTimer = null;
// Whether this gesture has seen any trigger-key event yet, which selects
// which of the two deadlines above applies.
let seenTriggerKey = false;

function armStuckGestureTimer() {
  clearTimeout(stuckGestureTimer);
  const timeout = seenTriggerKey ? STUCK_GESTURE_TIMEOUT_MS : INITIAL_KEY_DEADLINE_MS;
  stuckGestureTimer = setTimeout(() => {
    stuckGestureTimer = null;
    log(
      seenTriggerKey
        ? `[safety-net] No trigger-key activity for ${STUCK_GESTURE_TIMEOUT_MS}ms — force-closing.`
        : `[safety-net] No trigger-key event at all within ${INITIAL_KEY_DEADLINE_MS}ms — key was likely released before auto-repeat began; force-closing.`
    );
    // Reset the renderer too, not just this process — otherwise the
    // overlay keeps spaceHeld true and its drawn trail, and resumes
    // drawing an already-dead gesture the next time the mouse moves.
    overlayWindow.webContents.send('cancel-gesture');
    overlayWindow.hide();
    registerHotkey();
  }, timeout);
}

function clearStuckGestureTimer() {
  clearTimeout(stuckGestureTimer);
  stuckGestureTimer = null;
}

function registerHotkey() {
  for (const { accelerator, triggerKeyCode } of ACCELERATOR_CANDIDATES) {
    const registered = globalShortcut.register(accelerator, () => {
    log(`Hotkey pressed [${accelerator}] — waiting on keyup of ${triggerKeyCode}`);

    // Unregister immediately: while this accelerator stays registered,
    // macOS's global-hotkey layer claims the trigger key's own keyup
    // exclusively — it never dispatches as an ordinary window-scoped event,
    // even to a focused window (confirmed via diagnostic logging, see
    // decisions.md). Releasing the claim here lets the still-held key's
    // eventual release reach the overlay normally. Re-registered on finalize.
    // All candidates come off, not just the one that fired — any of them
    // still registered could claim its own key's events during the gesture.
    globalShortcut.unregisterAll();

    setTimeout(() => {
      const cursor = screen.getCursorScreenPoint();

      // Move the overlay to whichever display the cursor is on, per
      // activation. The gesture is a mouse drag, so cursor position — not
      // window focus, not the "main" display — is the direct signal for which
      // screen the user is about to act on. One built-in Electron call, no
      // Accessibility permission, no extra plumbing.
      //
      // Note this reuses getCursorScreenPoint(), which was measured returning
      // a ~29px-stale position when the cursor is moving fast (see the
      // activation-trail bug in decisions.md). Accepted deliberately here:
      // display selection only breaks if the cursor crosses a display
      // boundary within a few ms of the keypress, and the consequence would
      // be a one-off overlay on the neighbouring screen, not a wrong crop.
      const display = screen.getDisplayNearestPoint(cursor);
      activeDisplayId = display.id;
      overlayWindow.setBounds(display.bounds);

      // Read bounds back after the move, so the cursor-relative activation
      // point is expressed against the display the overlay now occupies.
      const bounds = overlayWindow.getBounds();
      overlayWindow.webContents.send('activate', {
        x: cursor.x - bounds.x,
        y: cursor.y - bounds.y,
        triggerKeyCode,
      });

      overlayWindow.show();
      // .focus() alone doesn't reliably win real OS focus-steal on macOS when
      // called from a global-shortcut callback (the app wasn't already
      // frontmost) — force it, then focus the window itself.
      app.focus({ steal: true });
      overlayWindow.focus();

      seenTriggerKey = false;
      armStuckGestureTimer();
    }, UNREGISTER_SETTLE_MS);
    });

    // A false here is itself a result: the accelerator is already claimed
    // system-wide, which rules the candidate out before any gesture is tried.
    if (!registered) {
      log(`Failed to register ${accelerator} — already claimed by another app or the OS.`);
    } else {
      log(`Registered ${accelerator}`);
    }
  }
}

// Single-instance guard. Structural fix for a confirmed failure mode: during
// Step 3 debugging, each round launched a new app without quitting the last,
// and a single physical keypress was observed firing in five separate
// instances within 2ms — every one of them had registered the same
// accelerator and called app.focus({steal:true}) on its own overlay. They
// fought over focus, which looked convincingly like an Electron focus bug and
// cost real time to diagnose (see decisions.md).
//
// Acquired here, before app.whenReady(), so a second instance exits before it
// can create a window or register the accelerator at all — the damage happens
// at registration, not later.
//
// Tradeoff accepted: a stale instance now makes `npm start` appear to do
// nothing instead of silently corrupting results. That is better, but only if
// the failure is legible — hence logging the recovery command rather than
// exiting quietly.
if (!app.requestSingleInstanceLock()) {
  log('Another instance is already running — exiting.');
  log('  Recover with: pkill -f "screen-region-agent/node_modules/electron"');
  app.quit();
} else {
  app.on('second-instance', () => {
    // Nothing to raise today: the overlay is a transient gesture surface, not
    // a window to show outside a gesture. At Step 5 the Chat Panel becomes the
    // right thing to focus here.
    log('A second instance tried to launch and was blocked by the single-instance lock.');
  });

  app.whenReady().then(() => {
    createWindow();
    createOverlayWindow();
    captureRegion = createCaptureRegion(overlayWindow);
    registerHotkey();
  });
}

ipcMain.on('debug-log', (event, msg) => log('[renderer]', msg));

// Auto-repeat keydown from the still-held trigger key. Re-arms the watchdog
// so a slow-but-active gesture is never force-closed mid-draw. Guarded on
// the timer still existing, so a late ping from an already-cancelled gesture
// can't resurrect a dead watchdog.
ipcMain.on('gesture-alive', () => {
  if (!stuckGestureTimer) return;
  // First trigger-key event of this gesture: the window can now see the key,
  // so the short initial deadline gives way to the 5s silence watchdog.
  seenTriggerKey = true;
  armStuckGestureTimer();
});

ipcMain.on('selection-finalized', async (event, bbox) => {
  clearStuckGestureTimer();

  if (!bbox) {
    log('Selection ignored (below minimum size)');
    overlayWindow.hide();
    registerHotkey();
    return;
  }

  log('Selection finalized:', bbox);

  // Hide for hygiene only — not load-bearing for capture correctness. The
  // overlay renderer already clears its own drawn trail/badge/reset-flash
  // synchronously on keyup, before this IPC message is even sent (see
  // overlay.js), so there is no visible overlay content left to bake into a
  // screenshot regardless of when hide() visually takes effect. An earlier
  // version of this handler used a guessed settle delay after hide() instead
  // — rejected on review as an unverified magic number, the same shape of
  // problem already on record for UNREGISTER_SETTLE_MS. See decisions.md.
  overlayWindow.hide();

  // The hotkey stays unregistered for the duration of this (re-registered
  // below, same as every other path through this handler), so there's never
  // a second gesture's capture request in flight at the same time.
  try {
    const { cropPath, fullPath } = await Promise.race([
      captureRegion(bbox, activeDisplayId),
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`captureRegion exceeded ${CAPTURE_OVERALL_TIMEOUT_MS}ms`)),
          CAPTURE_OVERALL_TIMEOUT_MS
        )
      ),
    ]);
    log('Captured region — crop:', cropPath, ' full:', fullPath);
  } catch (err) {
    log('captureRegion failed:', err.message || err);
    // Promise.race doesn't cancel the losing side. If this rejection came
    // from the overall timeout above (not from inside captureRegion itself),
    // the abandoned call may still be mid-flight and could still be holding
    // capture.js's ipcMain.once('capture-result', ...) listener. Clear it so
    // a late reply from this abandoned call can't be mistaken for the next
    // gesture's own capture result. Harmless to call unconditionally — in
    // the normal-completion case there's nothing left to remove.
    ipcMain.removeAllListeners('capture-result');
  }

  registerHotkey();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
