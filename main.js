const { app, BrowserWindow, globalShortcut, ipcMain, screen, nativeTheme, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { createCaptureRegion } = require('./src/shared/capture');
const { nodewhisper } = require('nodejs-whisper');
const { handleUserTurn } = require('./src/shared/responseHandler');
const { logConversation } = require('./src/shared/localLogger');
const { loadSettings, saveSettings, DICTATION_LANGUAGES } = require('./src/shared/settings');

// Phase 2.3: single in-memory copy of settings.json, read once at startup
// and kept in sync on every save handler below (each one reassigns this
// after writing to disk) — avoids a disk read on every hold-to-talk
// transcription just to look up the current dictation language. Populated
// for real inside app.whenReady(), before registerHotkey()'s first call —
// declared here so every function below can close over the same binding.
let appSettings;

// Timestamped logging — makes separate gestures distinguishable in the log,
// which mattered a lot while debugging the hotkey release path.
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

let overlayWindow;
let captureRegion;
// The Chat Panel is created fresh per session and closed (not hidden) when
// the session ends — see createChatPanelWindow(). Tracked at module level
// only so the single-instance guard's second-instance handler (below) can
// raise it instead of doing nothing, per the TODO already left there in
// Step 3. Never reused across sessions.
let chatPanelWindow = null;
// True only while the accelerator is unregistered for an in-progress
// hold-to-talk press — lets the Chat Panel's 'closed' handler recover
// immediately (re-register now) if the window closes mid-hold, rather than
// waiting out the watchdog below. See registerHotkey()'s chatPanelWindow
// guard and createChatPanelWindow()'s 'closed' handler.
let holdToTalkActive = false;

// Which display the current/most recent gesture's overlay was shown on —
// set once at activation (screen.getDisplayNearestPoint, already computed
// fresh there) and read at finalize time by captureRegion(). Re-deriving
// "which display" a second time at finalize, instead of threading this
// through, would risk disagreeing with activation's answer if the cursor
// moved off that display mid-drag — see decisions.md.
let activeDisplayId = null;

// Phase 2.3: set only while a Settings-initiated hotkey test's candidate is
// the one currently registered (in place of the production accelerator).
// null the rest of the time — the vastly more common case, and what every
// other path through the gesture/watchdog machinery below already assumes.
// { accelerator, triggerKeyCode, sender } — sender is the Main Window's
// webContents, so the test result can be replied to directly without a
// second module-level "which window asked" variable.
let hotkeyTestMode = null;

// Phase 2.2: the Main App Window (Captures/Settings/Help). Unlike the Chat
// Panel, this window is meant to persist and be reopened/reused across the
// app's runtime, not recreated per interaction (system_design_plan.md §3.8)
// — closer to the Overlay's reuse pattern than the Chat Panel's fresh-
// window-per-session one. null whenever it hasn't been created yet (lazy —
// this app is hotkey-first and shouldn't put a window in front of the user
// just for launching).
let mainWindow = null;

// True only during real app shutdown (app.quit()/Cmd+Q), set via
// 'before-quit'. Needed because showOrCreateMainWindow() intercepts the
// window's own 'close' to hide instead of destroy (see below) — without
// this guard, that same interception would also swallow a real quit,
// since Electron fires 'close' on every window it's about to shut down
// too, and preventDefault() there would just hide the window forever
// instead of letting the app exit.
let isQuitting = false;
app.on('before-quit', () => {
  isQuitting = true;
});

// Idempotent single entry point for both "open it for the first time" and
// "reopen it" — used by app.on('activate') below and reserved for a future
// menu item (deferred for 2.2, see decisions.md/todo.md). Deliberately not
// branching on BrowserWindow.getAllWindows().length: this app already has
// Overlay/Chat Panel windows coming and going, so a raw window-count check
// could misfire in ways specific to this app's multi-window shape — this
// only ever looks at its own `mainWindow` reference.
function showOrCreateMainWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 720,
    height: 480,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'src/mainWindow/mainWindowPreload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src/mainWindow/mainWindow.html'));

  // Hide, don't destroy — reopening should be instant, no reload. Only
  // lets the real close happen during actual app shutdown (isQuitting).
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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
      preload: path.join(__dirname, 'src/overlay/preload.js'),
    },
  });

  // macOS runs a separate Space per display by default ("Displays have
  // separate Spaces"). Without this, an overlay moved to the secondary
  // display renders and receives mouse events but never becomes the *key*
  // window: `app.focus({steal:true})` activates the app and macOS gives key
  // status to a window on whichever display's Space was active before
  // activation, not necessarily the overlay's own. Symptom was a trail that
  // drew normally and then died at the 2.5s no-key-event deadline while the
  // user was still holding.
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  overlayWindow.loadFile(path.join(__dirname, 'src/overlay/overlay.html'));
}

// Where a session's crop/full images live once a real conversation happened
// and they've been moved out of temp — see moveFile()/endChatSession() and
// decisions.md's temp-file-lifecycle row. Created lazily (only once a
// session actually needs it), not at startup.
const CAPTURES_DIR = path.join(app.getPath('userData'), 'captures');

// Moves one file out of temp into permanent storage. Prefers a plain
// rename() (atomic, no double-write) but falls back to copy+unlink on
// EXDEV — rename() can throw that if temp and userData ever end up on
// different filesystems/volumes. Not hypothetical enough to skip: silently
// losing the image a logged conversation record points at is exactly the
// failure the whole temp-file-lifecycle invariant exists to prevent.
function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

// Hold-to-talk voice transcription (system_design_plan.md §3.4, decisions.md
// 2026-08-23's backend evaluation — nodejs-whisper, replacing whisper-node-addon).
//
// Ephemeral, unlike crop.png/full.png: the data model (system_design_plan.md
// §5) only stores a turn's transcribed *text*, never the audio itself, so
// these WAV files have no temp-file-lifecycle invariant to satisfy — each is
// deleted immediately after this handler is done with it, success or
// failure, not routed through moveFile()/endChatSession() at all. Still
// given a dedicated subfolder rather than the OS temp root directly, for the
// same reason capture.js's screenshots are: consistency, and it costs
// nothing.
const VOICE_TMP_DIR = path.join(app.getPath('temp'), 'screen-region-voice');

// Floor on actual CAPTURED AUDIO duration, not raw press-to-release hold
// time — those aren't the same thing. A genuine single-word utterance
// ("yes", "stop") can involve a short hold that still contains a full
// word's worth of real audio; gating on hold-duration would risk silently
// discarding real speech, which is worse than the accidental-tap problem
// this exists to solve. Not tuned to "average utterance length" — just
// enough to filter a near-zero-audio accidental brush of the key.
const MIN_VOICE_DURATION_MS = 200;

// Builds a valid 16kHz mono 16-bit PCM WAV file in memory from raw Float32
// samples. Written by hand rather than relying on nodejs-whisper's own
// built-in conversion (which shells out to ffmpeg for anything that isn't
// already a valid WAV — confirmed by reading its source, decisions.md) —
// ffmpeg isn't installed here, and adding it would be a second Phase 7
// packaging dependency stacked on top of the one whisper-cli itself already
// needs (see todo.md). A WAV header is 44 fixed bytes; not worth a
// dependency to avoid writing it once.
function floatTo16BitWav(samples, sampleRate) {
  const numSamples = samples.length;
  const buffer = Buffer.alloc(44 + numSamples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + numSamples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // format = PCM
  buffer.writeUInt16LE(1, 22); // channels = mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono, 16-bit)
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(numSamples * 2, 40);
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), offset);
    offset += 2;
  }
  return buffer;
}

// nodejs-whisper's own type declaration claims Promise<string[][]>, but this
// was checked directly (`typeof`/`Array.isArray` against a real call, not
// just read from the diagnostic's printed output) and confirmed to actually
// return a plain timestamped string — e.g.
// "\n[00:00:00.000 --> 00:00:02.460]   Testing the Region Agent Voice input.\n".
// The string branch below is what real calls take; the array branch is kept
// as cheap insurance against the documented-but-unobserved shape, in case a
// future version of the package changes to match its own types — not
// exercised in practice, not worth deleting for that.
function extractTranscriptText(raw) {
  let text;
  if (typeof raw === 'string') {
    text = raw;
  } else if (Array.isArray(raw)) {
    text = raw.map((row) => (Array.isArray(row) ? row[row.length - 1] : String(row))).join(' ');
  } else {
    text = String(raw);
  }
  return text.replace(/^\s*\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, '').trim();
}

// Chat Panel (system_design_plan.md §3.4) — window lifecycle, the temp-file
// lifecycle invariant, hold-to-talk key mechanics, and text/voice input +
// message history are all built; see chatPanel.html for the renderer side.
//
// Created fresh per session, closed (not hidden) when the session ends —
// approved over reusing one window like the overlay: "history starts empty"
// is then free (a fresh page load) instead of something to manually reset,
// and the window's own 'closed' event is a single unambiguous trigger for
// the temp-file move-or-delete decision below, with no risk of state
// leaking across sessions the way track.getSettings() and the capture
// requestId race both did (see decisions.md) — this codebase has hit that
// bug shape twice already.
function createChatPanelWindow(cropPath, fullPath, displayId) {
  const display = screen.getAllDisplays().find((d) => d.id === displayId) || screen.getPrimaryDisplay();
  const width = 420;
  const height = 640;

  chatPanelWindow = new BrowserWindow({
    x: Math.round(display.bounds.x + (display.bounds.width - width) / 2),
    y: Math.round(display.bounds.y + (display.bounds.height - height) / 2),
    width,
    height,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'src/chatPanel/chatPanelPreload.js'),
    },
  });

  // Same fix the Selection Overlay needed (decisions.md): a window shown on
  // a display other than the currently active Space renders and takes mouse
  // events but never becomes the *key* window, so typing would silently do
  // nothing. Set once here at creation — since this window is created fresh
  // per session and never reused, "once at creation" already covers every
  // session, unlike the overlay where it only had to run once total.
  chatPanelWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  chatPanelWindow.loadFile(path.join(__dirname, 'src/chatPanel/chatPanel.html'));

  chatPanelWindow.show();
  // Same reasoning as the overlay's activation: .focus() alone doesn't
  // reliably win real OS focus-steal on macOS when the app isn't already
  // frontmost.
  app.focus({ steal: true });
  chatPanelWindow.focus();

  // Turns accumulate here as the panel's real UI sends them, via
  // 'chat-turn-added'; each addition also triggers a real model call
  // (Step 7, responseHandler.js's handleUserTurn()) below. Tracked in this
  // closure, not a module-level variable, so a session's state can never
  // leak into another's. The sender check is currently unreachable — only
  // one Chat Panel can exist at a time, since a Control+1 press while one
  // is open is guarded to focus it instead of starting a second gesture (see
  // registerHotkey()'s chatPanelWindow check) — but it's one line of cheap
  // insurance against exactly the crosstalk this codebase would get if that
  // guard were ever bypassed and two listeners on the same channel both
  // fired.
  const turns = [];
  // Session bounds for the logged record (system_design_plan.md §5's
  // started_at/ended_at) — captured here rather than derived from the
  // capture filenames' Date.now() stamp, since that marks capture time,
  // not chat-session time, and the two are conceptually different bounds
  // even though they land within moments of each other in practice.
  const startedAt = new Date().toISOString();
  // Tracks the AbortController for whichever askAboutRegion() call is
  // currently in flight, if any — null the rest of the time. Lets the
  // 'closed' handler below cancel a pending request per §7's "user closes
  // the panel mid-request" row, rather than letting it complete into a
  // destroyed window.
  let inFlightController = null;
  function onTurnAdded(event, turn) {
    if (event.sender.id !== chatPanelWindow.webContents.id) return;
    // The renderer disables its input while a reply is pending, so this
    // shouldn't be reachable in practice — cheap insurance against two
    // overlapping calls corrupting turns' assumed ordering, same shape as
    // the sender-id check above.
    if (inFlightController) return;
    turns.push(turn);
    const { controller, done } = handleUserTurn(chatPanelWindow, cropPath, turns);
    inFlightController = controller;
    // Clears the guard once this call actually finishes (not on window
    // close — that's handled separately below) — otherwise every turn
    // after the first would find inFlightController still set and never
    // fire. done never rejects, so no .catch needed here.
    done.then(() => { inFlightController = null; });
  }
  ipcMain.on('chat-turn-added', onTurnAdded);

  // Renderer-initiated retry after a failed call (chatPanel.html's error
  // bubble). turns already ends on the unanswered user turn from the
  // failed attempt — retry is just calling handleUserTurn() again with the
  // same array, no new turn to push. Guarded on the last turn actually
  // being an unanswered user turn so a stale/duplicate retry click can't
  // re-fire a call for a turn that already got a real reply.
  function onRetry(event) {
    if (event.sender.id !== chatPanelWindow.webContents.id) return;
    if (inFlightController) return; // same overlap guard as onTurnAdded
    const lastTurn = turns[turns.length - 1];
    if (!lastTurn || lastTurn.role !== 'user') return;
    const { controller, done } = handleUserTurn(chatPanelWindow, cropPath, turns);
    inFlightController = controller;
    done.then(() => { inFlightController = null; });
  }
  ipcMain.on('chat-retry', onRetry);

  // Feedback state for this session (Phase 2.1) — set via the title bar's
  // 👍/👎 buttons, tracked in this closure exactly like `turns` above so it
  // survives however the window actually closes (button click that then
  // closes the panel, Cmd+W, etc.), not read from the renderer at close
  // time. "Settable once per conversation" means one feedback value for
  // the whole session, not per-turn — the renderer may still send updates
  // (switching 👍↔👎, editing the note) any number of times before close;
  // only the latest value at close is what gets logged.
  let feedback = null;
  let feedbackNote = null;
  function onFeedbackSet(event, payload) {
    if (event.sender.id !== chatPanelWindow.webContents.id) return;
    feedback = payload.feedback;
    feedbackNote = payload.note;
  }
  ipcMain.on('chat-feedback-set', onFeedbackSet);

  chatPanelWindow.on('closed', () => {
    ipcMain.removeListener('chat-turn-added', onTurnAdded);
    ipcMain.removeListener('chat-retry', onRetry);
    ipcMain.removeListener('chat-feedback-set', onFeedbackSet);
    if (inFlightController) {
      inFlightController.abort();
      inFlightController = null;
    }
    if (holdToTalkActive) {
      // Window closed mid-hold — the accelerator is unregistered and no
      // more events for this now-gone window are coming, so there's no
      // reason to wait out the watchdog. Recover immediately instead.
      clearHoldToTalkWatchdog();
      holdToTalkActive = false;
      log('Chat Panel closed while hold-to-talk was active — re-registering hotkey immediately.');
      registerHotkey();
    }
    chatPanelWindow = null;
    endChatSession(cropPath, fullPath, turns, startedAt, feedback, feedbackNote);
  });
}

// turns is strictly append-only (main.js/responseHandler.js only ever
// push() onto it, never splice/remove), so a session that ends on an
// unanswered question — the panel closed mid-request (§7's cancel-on-
// close), an error the user never retried, or a retry that itself got
// cancelled — can only ever have that dangling turn as the *last* entry,
// never mid-array. That trailing {role: 'user'} turn has no real answer
// and must not be logged as a broken conversation (system_design_plan.md
// §7: "don't log a partial/broken conversation") — trimmed here, not at
// push time, so the renderer can still show the unanswered question on
// screen right up until the panel actually closes.
function trimToCompleteExchanges(turns) {
  if (turns.length > 0 && turns[turns.length - 1].role === 'user') {
    return turns.slice(0, -1);
  }
  return turns;
}

// The core invariant from decisions.md's temp-file-lifecycle row: exactly
// one of {move to permanent storage + log} or {delete, don't log}, never
// neither, never both. Gated on whether at least one *complete* exchange
// exists (loggableTurns.length > 0), not raw turns.length — a session
// that never got past a single unanswered question (e.g. cancelled
// immediately) has nothing worth keeping, same as a session with zero
// turns at all.
//
// Does NOT touch hotkey registration. The accelerator is never unregistered
// for the session's duration in the first place (see registerHotkey()'s
// chatPanelWindow guard) — only during the gesture+capture phase, same as
// always. Revised into this shape after review: the first version
// unregistered for the whole session and re-registered here, which (a)
// made a Control+1 press while the panel was open a structurally silent
// no-op — no callback ever fired, so there was no hook left to give
// feedback from — and (b) stranded the hotkey indefinitely with no
// watchdog if this function ever failed to run. See decisions.md.
function endChatSession(cropPath, fullPath, turns, startedAt, feedback, feedbackNote) {
  const loggableTurns = trimToCompleteExchanges(turns);
  if (loggableTurns.length === 0) {
    log('Chat Panel closed with no complete exchange — discarding temp captures.');
    for (const p of [cropPath, fullPath]) {
      try {
        fs.unlinkSync(p);
      } catch (err) {
        log('Failed to delete temp capture:', p, err.message);
      }
    }
  } else {
    try {
      fs.mkdirSync(CAPTURES_DIR, { recursive: true });
      const permCropPath = path.join(CAPTURES_DIR, path.basename(cropPath));
      const permFullPath = path.join(CAPTURES_DIR, path.basename(fullPath));
      moveFile(cropPath, permCropPath);
      moveFile(fullPath, permFullPath);
      logConversation({
        cropPath: permCropPath,
        contextPath: permFullPath,
        turns: loggableTurns,
        feedback,
        feedbackNote,
        startedAt,
        endedAt: new Date().toISOString(),
      });
      log(
        `Chat Panel closed with ${loggableTurns.length} turn(s) — moved to permanent storage and logged:`,
        permCropPath, permFullPath
      );
    } catch (err) {
      log('Failed to move captures to permanent storage / log conversation:', err.message);
    }
  }
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
    if (hotkeyTestMode) {
      const { sender } = hotkeyTestMode;
      hotkeyTestMode = null;
      sender.send('hotkey-test-result', { status: 'timeout' });
    }
    registerHotkey();
  }, timeout);
}

function clearStuckGestureTimer() {
  clearTimeout(stuckGestureTimer);
  stuckGestureTimer = null;
}

// Liveness watchdog for hold-to-talk, structurally identical to the gesture
// one above but kept as separate state rather than shared: the two can
// never actually be in flight at once (chatPanelWindow is either null or
// not, and each path requires the opposite), but they end differently on
// timeout (cancel a drawn overlay gesture vs. cancel an in-progress
// recording in the Chat Panel) — mixing them into one timer would mean
// branching on "which kind of hold is this" inside a single callback for no
// real benefit. Constants (STUCK_GESTURE_TIMEOUT_MS, INITIAL_KEY_DEADLINE_MS)
// are reused as-is, not reinvented: the same two-stage reasoning applies
// unchanged — Digit1 is claimed by the accelerator the same way for a
// hold-to-talk press as for a gesture press (confirmed 2026-08-23, see
// decisions.md), so the same ~445ms-until-auto-repeat blind window and the
// same "5s of silence, not 5s total" logic both carry over directly.
let holdToTalkWatchdog = null;
let seenHoldToTalkKey = false;

function armHoldToTalkWatchdog() {
  clearTimeout(holdToTalkWatchdog);
  const timeout = seenHoldToTalkKey ? STUCK_GESTURE_TIMEOUT_MS : INITIAL_KEY_DEADLINE_MS;
  holdToTalkWatchdog = setTimeout(() => {
    holdToTalkWatchdog = null;
    log(
      seenHoldToTalkKey
        ? `[hold-to-talk] No trigger-key activity for ${STUCK_GESTURE_TIMEOUT_MS}ms — force-closing.`
        : `[hold-to-talk] No trigger-key event at all within ${INITIAL_KEY_DEADLINE_MS}ms — key was likely released before auto-repeat began; force-closing.`
    );
    holdToTalkActive = false;
    // Guard, not redundant: the panel could have been closed out from under
    // an active hold (its own 'closed' handler clears this watchdog and
    // re-registers immediately in that case — see createChatPanelWindow) —
    // but a genuinely stuck hold with the panel still open needs this path.
    if (chatPanelWindow) {
      chatPanelWindow.webContents.send('hold-to-talk-cancel');
    }
    registerHotkey();
  }, timeout);
}

function clearHoldToTalkWatchdog() {
  clearTimeout(holdToTalkWatchdog);
  holdToTalkWatchdog = null;
}

// Positions the overlay on the cursor's display, sends 'activate', shows and
// focuses it, arms the watchdog — everything a gesture activation does after
// UNREGISTER_SETTLE_MS, extracted verbatim from registerHotkey()'s own
// callback so Phase 2.3's hotkey test (below) can run a real gesture through
// the exact same mechanism instead of a parallel implementation of it.
function activateGestureOverlay(triggerKeyCode) {
  const cursor = screen.getCursorScreenPoint();

  // Move the overlay to whichever display the cursor is on, per activation.
  // The gesture is a mouse drag, so cursor position — not window focus, not
  // the "main" display — is the direct signal for which screen the user is
  // about to act on. One built-in Electron call, no Accessibility
  // permission, no extra plumbing.
  //
  // Note this reuses getCursorScreenPoint(), which was measured returning a
  // ~29px-stale position when the cursor is moving fast (see the
  // activation-trail bug in decisions.md). Accepted deliberately here:
  // display selection only breaks if the cursor crosses a display boundary
  // within a few ms of the keypress, and the consequence would be a one-off
  // overlay on the neighbouring screen, not a wrong crop.
  const display = screen.getDisplayNearestPoint(cursor);
  activeDisplayId = display.id;
  overlayWindow.setBounds(display.bounds);

  // Read bounds back after the move, so the cursor-relative activation point
  // is expressed against the display the overlay now occupies.
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
}

// Phase 2.3 — tests a candidate accelerator via a real hold-drag-release
// gesture, reusing the exact overlay/watchdog machinery a production gesture
// already goes through (activateGestureOverlay, armStuckGestureTimer,
// selection-finalized's own bbox logic) rather than a parallel test harness.
// See decisions.md.
//
// Runs with the production hotkey unregistered for the test's bounded
// duration — the same exposure window a real gesture already has today,
// because the gesture/watchdog state this reuses (stuckGestureTimer,
// seenTriggerKey, activeDisplayId, the one overlayWindow) is single-flight:
// there's only ever one gesture's worth of it, so a candidate test and a
// real production gesture can't run through it at once without colliding.
// Registering the candidate is what actually starts the test — the function
// just arms it; the real gesture happens when the user does the hold-drag-
// release themselves.
function startHotkeyTest(accelerator, triggerKeyCode, sender) {
  if (hotkeyTestMode || chatPanelWindow || holdToTalkActive) {
    sender.send('hotkey-test-result', { status: 'busy' });
    return;
  }

  globalShortcut.unregisterAll();
  const registered = globalShortcut.register(accelerator, () => {
    setTimeout(() => activateGestureOverlay(triggerKeyCode), UNREGISTER_SETTLE_MS);
  });

  if (!registered) {
    // Already claimed by macOS or another app — rules the candidate out
    // before any gesture is even attempted. Nothing was ever unavailable
    // beyond this synchronous check, so just restore production directly.
    registerHotkey();
    sender.send('hotkey-test-result', { status: 'already-in-use' });
    return;
  }

  hotkeyTestMode = { accelerator, triggerKeyCode, sender };
  sender.send('hotkey-test-result', { status: 'armed' });
}

// Re-arms the same candidate for another attempt after a below-minimum-size
// gesture, without ending the test — see selection-finalized's test branch
// for why that case is inconclusive rather than a failure.
function rearmHotkeyTest() {
  const { accelerator, triggerKeyCode } = hotkeyTestMode;
  globalShortcut.unregisterAll();
  const registered = globalShortcut.register(accelerator, () => {
    setTimeout(() => activateGestureOverlay(triggerKeyCode), UNREGISTER_SETTLE_MS);
  });
  if (!registered) {
    // Shouldn't happen — it just worked a moment ago — but don't strand the
    // hotkey if it does.
    const { sender } = hotkeyTestMode;
    hotkeyTestMode = null;
    registerHotkey();
    sender.send('hotkey-test-result', { status: 'already-in-use' });
  }
}

function registerHotkey() {
  for (const { accelerator, triggerKeyCode } of ACCELERATOR_CANDIDATES) {
    const registered = globalShortcut.register(accelerator, () => {
    log(`Hotkey pressed [${accelerator}] — waiting on keyup of ${triggerKeyCode}`);

    // A Chat Panel session is already open — checked here, before anything
    // else. Deliberately keeping the accelerator registered throughout the
    // session rather than unregistering for its whole duration: that
    // alternative was tried first and rejected on review — it made a press
    // while blocked a structurally silent no-op (no callback ever fires, so
    // there's no hook to react from) and stranded the hotkey indefinitely
    // with no watchdog if the session ever failed to close cleanly. See
    // decisions.md. What happens next depends on whether the panel actually
    // has focus right now:
    if (chatPanelWindow) {
      if (chatPanelWindow.isFocused()) {
        // Hold-to-talk: the same physical key, held again once the panel
        // already has real OS focus (system_design_plan.md §3.4,
        // decisions.md). Mirrors the region-selection gesture mechanism
        // exactly, for the same underlying reason: Digit1 is claimed by
        // the accelerator here too — confirmed empirically 2026-08-23 (not
        // assumed from the older, now-superseded decisions.md row 27) —
        // and it recurs on every hold-to-talk attempt, not occasionally,
        // since modifier-before-trigger is the only press order that ever
        // matches the accelerator at all. So unregister here, exactly as a
        // gesture does, and let the renderer bootstrap its "held" state
        // from this activation signal rather than from a local keydown —
        // same principle as the overlay (decisions.md), for the same
        // reason: a key already down when this context starts does not
        // reliably fire a fresh keydown.
        log('Hotkey pressed while the Chat Panel has focus — starting hold-to-talk.');
        globalShortcut.unregisterAll();
        holdToTalkActive = true;
        seenHoldToTalkKey = false;
        chatPanelWindow.webContents.send('hold-to-talk-start');
        armHoldToTalkWatchdog();
        return;
      }

      // Not focused (user is elsewhere) — don't start a second gesture
      // (which would spawn a second, colliding panel) and don't start
      // hold-to-talk (nothing asked for it). Reuses the same "focus the
      // existing thing" response as the second-instance guard below,
      // instead of inventing a new one.
      log('Hotkey pressed while a Chat Panel session is open — focusing it instead of starting a new gesture.');
      if (chatPanelWindow.isMinimized()) chatPanelWindow.restore();
      chatPanelWindow.focus();
      return;
    }

    // Unregister immediately: while this accelerator stays registered,
    // macOS's global-hotkey layer claims the trigger key's own keyup
    // exclusively — it never dispatches as an ordinary window-scoped event,
    // even to a focused window (confirmed via diagnostic logging, see
    // decisions.md). Releasing the claim here lets the still-held key's
    // eventual release reach the overlay normally. Re-registered on finalize.
    // All candidates come off, not just the one that fired — any of them
    // still registered could claim its own key's events during the gesture.
    globalShortcut.unregisterAll();

    setTimeout(() => activateGestureOverlay(triggerKeyCode), UNREGISTER_SETTLE_MS);
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
    // The overlay is still a transient gesture surface, not something to
    // raise here — but per the TODO this comment used to carry, the Chat
    // Panel (Step 5) is: if a session is open, surface it instead of doing
    // nothing.
    if (chatPanelWindow) {
      if (chatPanelWindow.isMinimized()) chatPanelWindow.restore();
      chatPanelWindow.focus();
      log('A second instance tried to launch — focused the existing Chat Panel instead.');
    } else {
      log('A second instance tried to launch and was blocked by the single-instance lock.');
    }
  });

  app.whenReady().then(() => {
    // Phase 2.3: load persisted settings before anything that depends on
    // them is created — the hotkey accelerator and the theme both need to
    // be correct from the very first window/registration, not patched in
    // after the fact.
    appSettings = loadSettings();
    ACCELERATOR_CANDIDATES[0] = {
      accelerator: appSettings.hotkeyAccelerator,
      triggerKeyCode: appSettings.hotkeyTriggerKeyCode,
    };
    // 'system' is nativeTheme's own default and merely removes any prior
    // override, so this is a no-op on first launch — setting it
    // unconditionally on every launch is simpler than special-casing that.
    nativeTheme.themeSource = appSettings.theme;

    // Phase 2.2: without this, the app's Dock activation policy stays
    // "background only" on this Electron install/environment — confirmed
    // directly via a throwaway diagnostic (osascript's "background only"
    // flipped from true to false only after calling this), not assumed
    // from docs. Nothing before Phase 2.2 needed a Dock icon: every real
    // gesture used the global hotkey + app.focus({steal:true}), which
    // works regardless of Dock-icon presence. This is the first feature
    // that actually depends on the icon existing for 'activate' to fire.
    if (app.dock) app.dock.show();
    createOverlayWindow();
    captureRegion = createCaptureRegion(overlayWindow);
    registerHotkey();
  });

  // Registered inside the single-instance-lock gate, consistent with the
  // rest of startup — a blocked second instance quits right after this
  // point anyway, so there's no real window for 'activate' to meaningfully
  // fire before that quit completes, but keeping every real setup call
  // gated the same way is one less thing to reason about.
  app.on('activate', showOrCreateMainWindow);
}

ipcMain.on('debug-log', (event, msg) => log('[renderer]', msg));

// Phase 2.3 — Settings page (system_design_plan.md §3.8). All requests come
// from the Main App Window only, so replying via event.sender is safe
// without a sender-id check the way the Chat Panel's per-session handlers
// need one — there's exactly one Main Window, a persistent singleton, not
// something recreated per interaction.

ipcMain.on('settings-get', (event) => {
  event.sender.send('settings-data', appSettings);
});

ipcMain.on('settings-set-display-name', (event, displayName) => {
  appSettings = saveSettings({ displayName });
  event.sender.send('settings-data', appSettings);
});

ipcMain.on('settings-set-theme', (event, theme) => {
  appSettings = saveSettings({ theme });
  nativeTheme.themeSource = theme; // takes effect immediately, app-wide
  event.sender.send('settings-data', appSettings);
});

ipcMain.on('settings-set-dictation-language', (event, dictationLanguage) => {
  appSettings = saveSettings({ dictationLanguage });
  event.sender.send('settings-data', appSettings);
});

// Hotkey test flow (Phase 2.3, decisions.md — reuses the real gesture
// machinery, see startHotkeyTest()/rearmHotkeyTest() above).
ipcMain.on('hotkey-test-start', (event, { accelerator, triggerKeyCode }) => {
  startHotkeyTest(accelerator, triggerKeyCode, event.sender);
});

// User-initiated abort (closed the test UI, or gave up before completing
// the gesture) — not just the watchdog's own timeout path. Safe to call
// unconditionally; a no-op if no test is running.
ipcMain.on('hotkey-test-cancel', () => {
  if (!hotkeyTestMode) return;
  clearStuckGestureTimer();
  overlayWindow.webContents.send('cancel-gesture');
  overlayWindow.hide();
  hotkeyTestMode = null;
  registerHotkey();
});

// Only reachable after a real 'pass' result — the renderer gates the Save
// control on that. Persists the tested candidate as the production
// accelerator and re-registers it immediately.
ipcMain.on('hotkey-save', (event, { accelerator, triggerKeyCode }) => {
  ACCELERATOR_CANDIDATES[0] = { accelerator, triggerKeyCode };
  appSettings = saveSettings({ hotkeyAccelerator: accelerator, hotkeyTriggerKeyCode: triggerKeyCode });
  registerHotkey();
  event.sender.send('settings-data', appSettings);
});

ipcMain.on('data-open-folder', () => {
  shell.openPath(app.getPath('userData'));
});

// Destructive — confirmed via a native dialog before anything is deleted,
// same "confirm before an irreversible action" posture as the rest of this
// project (Electron's built-in dialog module, no new dependency). Deletes
// conversations.jsonl and every file under captures/, not settings.json
// itself — clearing captured data shouldn't also reset the user's Settings.
ipcMain.on('data-clear-all', async (event) => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Delete everything'],
    defaultId: 0,
    cancelId: 0,
    message: 'Delete all captured conversations?',
    detail: 'This permanently deletes conversations.jsonl and every stored capture image. This cannot be undone.',
  });
  if (response !== 1) {
    event.sender.send('data-clear-result', { status: 'cancelled' });
    return;
  }
  try {
    fs.rmSync(path.join(app.getPath('userData'), 'conversations.jsonl'), { force: true });
    fs.rmSync(CAPTURES_DIR, { recursive: true, force: true });
    log('[data-privacy] Cleared all captured conversations and images.');
    event.sender.send('data-clear-result', { status: 'cleared' });
  } catch (err) {
    log('[data-privacy] Failed to clear data:', err.message);
    event.sender.send('data-clear-result', { status: 'error', message: err.message });
  }
});

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

// Auto-repeat keydown from the still-held hold-to-talk key. Same pattern as
// gesture-alive above, kept as a separate handler/timer rather than shared
// — see armHoldToTalkWatchdog()'s comment for why.
ipcMain.on('hold-to-talk-alive', () => {
  if (!holdToTalkWatchdog) return;
  seenHoldToTalkKey = true;
  armHoldToTalkWatchdog();
});

// The renderer's real Digit1 keyup — the only trusted signal that a
// hold-to-talk press has ended, exactly parallel to how a gesture only ever
// ends on the overlay's real keyup, never a timeout (decisions.md). The
// watchdog above is a safety net for a stuck/lost-event case, not the
// normal end path.
//
// audioPayload is null if the renderer never captured anything (mic
// permission denied/unavailable, or getUserMedia failed) — see
// chatPanel.html. Otherwise { samples: ArrayBuffer, sampleRate: number },
// raw Float32 data straight from the renderer's audio graph: per
// capture.js's established split, the renderer only hands back raw data,
// every real decision (WAV construction, the duration guard, the actual
// transcription call) happens here.
//
// Hotkey re-registration happens immediately, before any of the async
// transcription work below — the key mechanics are done the instant the
// real keyup arrives; there's no reason the accelerator should stay
// unregistered for however long whisper takes to run.
ipcMain.on('hold-to-talk-end', async (event, audioPayload) => {
  clearHoldToTalkWatchdog();
  holdToTalkActive = false;
  log('Hold-to-talk ended by real keyup — re-registering hotkey.');
  registerHotkey();

  if (!audioPayload) {
    log('[hold-to-talk] No audio captured (mic unavailable) — nothing to transcribe.');
    return;
  }

  const samples = new Float32Array(audioPayload.samples);
  const { sampleRate } = audioPayload;
  const durationMs = (samples.length / sampleRate) * 1000;

  if (durationMs < MIN_VOICE_DURATION_MS) {
    log(`[hold-to-talk] Captured audio too short (${durationMs.toFixed(0)}ms < ${MIN_VOICE_DURATION_MS}ms) — skipping transcription.`);
    if (chatPanelWindow) chatPanelWindow.webContents.send('hold-to-talk-too-short');
    return;
  }

  let wavPath;
  try {
    fs.mkdirSync(VOICE_TMP_DIR, { recursive: true });
    wavPath = path.join(VOICE_TMP_DIR, `voice-${Date.now()}.wav`);
    fs.writeFileSync(wavPath, floatTo16BitWav(samples, sampleRate));

    // Phase 2.3: model + pinned language come from the Settings dictation-
    // language control (default 'en', unchanged from before this step).
    // whisperOptions.language is nested, not a top-level IOptions field —
    // confirmed by reading nodejs-whisper's own type defs and the source
    // that turns it into whisper.cpp's `-l` flag, not assumed from the name
    // alone (see decisions.md — same standard as extractTranscriptText()).
    const { modelName, whisperLanguage } = DICTATION_LANGUAGES[appSettings.dictationLanguage] || DICTATION_LANGUAGES.en;
    const rawTranscript = await nodewhisper(wavPath, {
      modelName,
      autoDownloadModelName: modelName,
      removeWavFileAfterTranscription: false, // cleaned up ourselves below regardless of outcome
      whisperOptions: { language: whisperLanguage },
      logger: { log: () => {}, debug: () => {}, error: (...args) => log('[whisper]', ...args) },
    });
    const text = extractTranscriptText(rawTranscript);
    log('[hold-to-talk] Transcribed:', JSON.stringify(text));
    if (chatPanelWindow) chatPanelWindow.webContents.send('hold-to-talk-transcript', text);
  } catch (err) {
    log('[hold-to-talk] Transcription failed:', err.message);
    if (chatPanelWindow) chatPanelWindow.webContents.send('hold-to-talk-error', err.message);
  } finally {
    if (wavPath) {
      try {
        fs.unlinkSync(wavPath);
      } catch (err) {
        log('[hold-to-talk] Failed to clean up temp WAV:', wavPath, err.message);
      }
    }
  }
});

ipcMain.on('selection-finalized', async (event, bbox) => {
  clearStuckGestureTimer();

  if (hotkeyTestMode) {
    overlayWindow.hide();
    const { accelerator, sender } = hotkeyTestMode;
    if (!bbox) {
      // Below minimum size — inconclusive, not a failure. The candidate is
      // still a perfectly plausible working accelerator; the user just
      // didn't drag far enough this attempt. Re-arm immediately for another
      // try rather than reverting to production — same accelerator stays
      // registered, no need to make them re-click "Test".
      log(`[hotkey-test] Gesture below minimum size — re-arming ${accelerator} for another attempt.`);
      sender.send('hotkey-test-result', { status: 'too-small' });
      rearmHotkeyTest();
      return;
    }
    log(`[hotkey-test] ${accelerator} passed — real gesture finalized.`);
    hotkeyTestMode = null;
    registerHotkey(); // restore production; candidate isn't live until Save
    sender.send('hotkey-test-result', { status: 'pass' });
    return;
  }

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
  let cropPath, fullPath;
  try {
    ({ cropPath, fullPath } = await Promise.race([
      captureRegion(bbox, activeDisplayId),
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`captureRegion exceeded ${CAPTURE_OVERALL_TIMEOUT_MS}ms`)),
          CAPTURE_OVERALL_TIMEOUT_MS
        )
      ),
    ]));
    log('Captured region — crop:', cropPath, ' full:', fullPath);
  } catch (err) {
    log('captureRegion failed:', err.message || err);
    // Secondary hygiene only, not load-bearing for correctness (see
    // capture.js's requestId comment for why): if this rejection came from
    // the overall timeout above rather than from inside captureRegion
    // itself, the abandoned call may still be mid-flight and holding a
    // 'capture-result' listener that's now waiting for a reply nobody needs.
    // requestId already guarantees that reply — whenever it eventually
    // arrives — can't be mistaken for a future gesture's own result; this
    // just removes it eagerly instead of leaving it to self-remove later.
    // Safe to call unconditionally — nothing to remove in the normal-
    // completion case, and a subsequent gesture can never be in flight here
    // (the hotkey stays unregistered until this handler returns).
    ipcMain.removeAllListeners('capture-result');
    registerHotkey();
    return;
  }

  createChatPanelWindow(cropPath, fullPath, activeDisplayId);
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
