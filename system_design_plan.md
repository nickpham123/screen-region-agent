# System Design Plan — Screen-Region AI Agent

## 1. Goals & constraints

- **Primary flow**: hold hotkey → draw selection → release → a chat panel opens where the user can have a short back-and-forth about that region, then closes it when done
- **Privacy-first**: screen content is sensitive by nature; no silent capture, no unnecessary retention
- **Model-agnostic core**: the vision "brain" (Mistral now, fine-tuned Qwen2.5-VL later) should be swappable without touching the client pipeline
- **Single-user today, multi-user later**: design the interfaces now so a client-server split doesn't require a rewrite

---

## 2. High-level architecture

```
┌─────────────────────────────────────────────────────────┐
│                      DESKTOP CLIENT                      │
│                                                           │
│  ┌──────────────┐   ┌────────────────┐   ┌────────────┐  │
│  │ Hotkey       │──▶│ Selection      │──▶│ Screen      │  │
│  │ Listener     │   │ Overlay        │   │ Capture     │  │
│  │ (globalShort-│   │ (BrowserWindow,│   │(desktopCapt-│  │
│  │  cut, press) │   │  takes focus)  │   │  urer)      │  │
│  └──────────────┘   └────────────────┘   └──────┬──────┘  │
│                                                  │         │
│  ┌──────────────┐   ┌────────────────┐   ┌──────▼──────┐  │
│  │ Chat Panel   │◀──│ Response       │◀──│ Vision      │  │
│  │ (BrowserWin- │──▶│ Handler        │──▶│ Model Client│  │
│  │  dow, focused│   │                │   │             │  │
│  │  multi-turn) │   │                │   │             │  │
│  └──────┬───────┘   └───────┬────────┘   └──────┬──────┘  │
│         │ (on close)        │                   │         │
│         ▼                   │                   │         │
│  ┌─────────────────┐        │                   │         │
│  │ Local Logger    │◀───────┘                   │         │
│  │ (SQLite/JSONL)  │                             │         │
│  └─────────────────┘                             │         │
└───────────────────────────────────────────────────┼───────┘
                                                      │
                                                      ▼
                                        ┌─────────────────────────┐
                                        │   Mistral API (hosted)   │
                                        │  mistral-small-latest    │
                                        └─────────────────────────┘
```

Everything today lives in one process on the user's machine except the single outbound call to Mistral. That's intentional — it's the simplest architecture that lets you validate the product before any backend exists.

---

## 3. Components

### 3.1 Hotkey Listener
- **Responsibility**: detect the hotkey press, activate the overlay, which immediately takes focus
- **Tech**: Electron's `globalShortcut` module for the initial press (main process)
- **Interface**: emits `onSelectionStart()`
- **Note on the hold-to-select gesture**: `globalShortcut` alone has no keyup event — a long-standing Electron limitation. The workaround: the moment the press fires, the Selection Overlay window appears and takes OS keyboard focus immediately. From that instant, the *same* physical key is tracked via ordinary window-scoped `keydown`/`keyup` (not `globalShortcut`). So the user genuinely holds one key through the whole select gesture — the two-stage detection (global press → window-scoped hold/release) is an implementation detail, invisible to the user.
- **Correction — the window-scoped half is NOT unconditionally reliable** (first revised 2026-08-20; substantially revised again 2026-08-21 once the root mechanism was found). An early draft of this section claimed window-scoped tracking "works completely normally, including release." It does not, for four distinct reasons, and a subsequent draft of this section also misdiagnosed the main one.
  > **The full mechanism lives in `.claude/memory/decisions.md` → "Hold/release detection on macOS + Electron"**, written as one consolidated narrative precisely so it isn't reconstructed from scattered corrections. Read that before touching gesture input. Summarised here only so this document isn't misleading on its own:
  1. **The accelerator consumes the trigger key's first `keydown`** — the overlay never receives it, and stays blind to the key until macOS auto-repeat begins (~445ms measured). A key the window never saw yields no `keyup` either, so releasing inside that window leaves the gesture unable to end. This is the root cause of what earlier drafts filed separately as "quick taps are intermittently unreliable" (deterministic, not intermittent) and "sometimes the hotkey does nothing" (the accelerator is unregistered for the whole hang).
  2. **The accelerator must be unregistered during the gesture**, or macOS's global-hotkey layer claims the trigger key's `keyup`. Note the diagnostic that originally established this was collected on a broken accelerator and has a competing explanation (see #3); the call remains in the code and gestures work, but whether it is load-bearing is untested.
  3. **Input-method layers can consume the trigger key entirely.** Option is macOS's special-character modifier (`Alt+Space` delivered zero `Space` events across 25 gestures); the input-source switcher does the same to `Control+Space`. Symptom is misleading — accelerator fires, window reports focus, no key events arrive. **Never put `Option`/`Alt` in the chord**, and verify any candidate hands-on: five accelerators registered successfully and still failed.
  4. **The modifier must be pressed before the trigger key.** macOS only matches a global accelerator when modifier flags are already set; simultaneous presses frequently fail to activate.
  - **Retracted**: an earlier draft of this section claimed "keyboard events sometimes do not reach a window that reports having focus," implying a general Electron/macOS focus-delivery defect. That was an artifact of multiple app instances competing for the same accelerator during testing. Measured cleanly, focus acquisition is fine.
- **Stuck-gesture safety net — two deadlines, not one**: a main-process timer force-closes gestures that never resolve, so the app cannot hang or strand the hotkey unregistered. It is a **liveness watchdog**, not a fixed deadline: a held key auto-repeats `keydown` every ~80ms, the renderer forwards those as pings, and the timer measures *silence* (5s) rather than elapsed time — so an active hold is never truncated at any length. A separate, shorter deadline (2.5s) closes gestures where no trigger-key event ever arrives, i.e. the key was released inside the blind window in #1. That value is sized above macOS's slowest configurable key-repeat delay (~2s, a motor-accessibility setting) so it cannot cancel a genuine hold.

### 3.2 Selection Overlay
- **Responsibility**: render a transparent full-screen window, take focus immediately on activation, track the mouse as a freeform path while the hotkey is held, produce a bounding box on key release
- **Tech**: a transparent `BrowserWindow` (visual transparency only — receives mouse/keyboard events normally, not Electron's input-transparent "click-through" mode) + HTML/CSS/JS
- **Interface**: on hotkey release, emits `(x, y, width, height)` in screen coordinates — the bounding box (min/max X, min/max Y) of the traced path, not a true polygon mask
- **Freeform gesture, rectangular capture**: the user draws whatever shape feels natural (the whole point of "circling" something) — but on release, only the bounding box of that path is ever sent to the model. This sidesteps two problems at once: (1) vision models tokenize images as a fixed rectangular patch grid, so an irregular mask wouldn't meaningfully help the model anyway — it would just flatten excluded pixels to a solid color; (2) it means capture/crop logic stays exactly as simple as pure bounding-box, since the only new work is computing min/max over a path instead of two corners
- **Traced path/trail**: a visible line following the actual cursor trajectory while the hotkey is held, so the gesture reads as freeform circling rather than a plain rectangle-drag — a rendering requirement, not just internal bookkeeping for the bbox math. The underlying bounding box (min/max X, min/max Y) is still computed continuously from the same tracked points, feeding the final crop, but is not itself rendered — see "Live bbox preview, superseded" below.
- **Live bbox preview — superseded by click-to-reset**: an earlier version of this design rendered the running bounding box as a translucent rectangle outline continuously while dragging, specifically so an elongated/sprawling path (which can bound-box into far more area than the user realizes) could be self-corrected in real time before release. That box only ever grew within one continuous gesture — a true accumulating min/max over every point visited, not a distance-from-start box — so it never shrank mid-gesture by design. This is now superseded: with click-to-reset (a plain click while the hotkey is held clears the current trail and bbox tracking and starts fresh from the click point, with a visible flash cue confirming the reset), discarding a bad/oversized path is one click away rather than requiring a full release-and-repress. That makes the always-visible box redundant as a safety net, so it's no longer rendered — the bbox is still computed the same way under the hood, purely for the final crop, and still resets fresh on each activation or click.
- **Ready indicator**: the instant the overlay activates (before any drag starts), show a small floating pill/badge — outlined, translucent style — reading something like "Release to select" near the cursor. This confirms the hotkey actually registered, which matters since there's otherwise no feedback in that brief window before dragging begins. Once dragging starts, the trail becomes the primary visual feedback and the badge can fade out. Verified 2026-08-21 that it survives a 16s stationary hold, i.e. it fades only on genuine movement.
- **Never draw from the activation point** (added 2026-08-21): the first two mousemoves of a gesture are consumed before drawing — one discarded, one used as the drawing origin. Two independent problems make the naive approach wrong: showing the overlay under the cursor emits a *synthetic* mousemove with bogus coordinates, and the activation point itself (`getCursorScreenPoint()` at press time) goes stale if the cursor is still moving when the hotkey is pressed — measured 29px off. Together these drew a phantom trail on every activation and let taps finalize bogus selections. Consequence: **a selection begins where drawing actually started, not where the cursor was at press time**, which is the more correct behavior. Full detail in `.claude/memory/decisions.md`.

### 3.3 Screen Capture
- **Responsibility**: grab pixels for the given bounding box, plus a full-screen frame for context
- **Tech**: Electron's `desktopCapturer` + Node image handling for crop/encode
- **Interface**: `captureRegion(bbox) -> (cropImage, fullImage)`

### 3.4 Chat Panel
- **Responsibility**: the full conversational interface for one session — text/voice input, message history display, submitting turns to the model, and closing to end the session. This merges what earlier drafts had as two separate pieces (a question popup and a separate answer popup) into one persistent panel.
- **Tech**: a `BrowserWindow` popup that opens immediately after capture and takes focus. Text field auto-focused. Voice: same key as the selection hold, held again while this panel has focus (ordinary window-scoped `keydown`/`keyup` — works for the same reason described in 3.1) — buffers audio while held, transcribes the full clip on release via **`whisper-node-addon`** (local whisper.cpp, Metal-accelerated on Apple Silicon). Message history renders as the conversation grows.
- **Interface**:
  ```
  onSubmitTurn(questionText) -> triggers Response Handler with full running history
  onClose() -> ends the session, hands the complete turn list to Local Logger
  ```
- **Conversation scope — ephemeral, session-only**: turns within one open panel share context (the model sees the full history so far, so follow-ups like "give me an example" work). Once the panel closes, that conversation is over — nothing is resumed or persisted for later browsing. The full turn history is logged once, at close, for the fine-tuning dataset (see §5) — but that's a one-way write, not a resumable chat log.
- **Note on voice**: audio never leaves the device — consistent with "nothing leaves the device without the active query." Transcription is record-then-transcribe-on-release, not live word-by-word streaming (whisper.cpp doesn't naturally support that without real added complexity — not worth it for v1).
- **Feedback buttons** (Phase 2.1): 👍/👎 in the title bar, persistent for the whole session, settable once per conversation. No schema change — `feedback` already exists on the per-conversation record (§5).
- **Captured-region thumbnail** (Phase 2.6): a small thumbnail of the circled region, shown in the panel from the moment it opens. Passed once at panel creation as a data URL from the already-in-memory capture — no extra file read or IPC round-trip needed. Clicking it opens the full crop image in the system's default viewer via `shell.openPath` over IPC.
- **Hold-to-talk mic level indicator** (Phase 2.6): a real-time level meter driven by RMS computed inline in the existing `ScriptProcessorNode` callback that already has the raw PCM buffer in hand — not a decorative loop animation independent of actual mic input.

### 3.5 Vision Model Client
- **Responsibility**: package image(s) + the running conversation into a model call, return the next answer
- **Tech**: JS module calling Mistral's REST API via `fetch` — JS port of `mistral_vision_query.py` (the Python file remains as reference for the single-turn logic, not called directly)
- **Interface (stable contract — this is what makes the model swappable)**:
  ```
  askAboutRegion(imagePath, conversationHistory) -> answerText
  ```
  `conversationHistory` is the growing list of `{role, content}` turns for this session (first call is just the one user turn; each follow-up includes everything before it). This is a change from the single-shot `askAboutRegion(imagePath, question)` in earlier drafts — necessary now that follow-ups need context. Mistral's chat API accepts multi-turn messages natively, so this is a straightforward extension, not a rework. Any future backend (fine-tuned Qwen2.5-VL, local model, etc.) implements this same shape. Nothing upstream needs to change when the backend changes.
- **Full-screenshot context — hybrid approach**: a heavily downscaled thumbnail of the full screenshot is sent alongside the crop on *every* call — cheap, since image tokens scale with resolution, and it means the model always has at least coarse surrounding context without depending on it. On top of that baseline, the model is given a tool it can invoke (e.g. `requestFullScreenshot()`) to request the full-resolution screenshot for the rare case the thumbnail isn't enough (e.g. needs to read small text elsewhere on screen), triggering one extra round-trip only when actually needed. Chosen over tool-calling alone because smaller/cheaper models like Mistral Small aren't reliably self-aware about needing more context — they're more likely to guess confidently than ask. The thumbnail baseline removes that failure mode for the common case.
- **Cost note**: each follow-up re-sends the full history plus the image(s), so a longer in-session conversation costs more tokens than an equivalent number of independent single-shot calls would. Two mitigations worth implementing rather than capping conversation length: (1) Mistral supports prompt caching via a stable `prompt_cache_key` — since the prefix (system prompt + image + prior turns) is identical across calls except for the newly appended turn, this should cut repeated-content cost substantially (reportedly ~90% on cached tokens, unconfirmed against Mistral's live docs — verify before relying on it); (2) downscale the crop image before sending — image tokens scale with resolution, so a modestly compressed image cuts the absolute cost of every call regardless of caching.

### 3.6 Response Handler
- **Responsibility**: orchestrate the call, handle errors/timeouts, hand results back to the Chat Panel
- **Tech**: plain JS, glue layer (main process)

### 3.7 Local Logger
- **Responsibility**: on session close, write the complete conversation (all turns) to local storage in the fine-tuning-ready schema
- **Tech**: SQLite (e.g. `better-sqlite3`) or flat JSONL file
- **Interface**: `logConversation(cropPath, contextPath, appHint, turns, feedback)`

### 3.8 Main App Window (Phase 2)
- **Responsibility**: a persistent home for everything that isn't the ephemeral hotkey→overlay→chat flow — browsing past captures, changing settings, and a static help guide. Distinct lifecycle from the Overlay/Chat Panel: opened via the dock icon or app menu, not the hotkey, and — unlike the Chat Panel's fresh-window-per-session design (§3.4, decisions.md) — this window is meant to persist and be reopened/reused across the app's runtime, not recreated per interaction.
- **Tech**: a single persistent `BrowserWindow` (`mainWindow.html`). Captures/Settings/Help are views inside that one window, switched client-side via a sidebar — not three separate `BrowserWindow`s. Chosen to avoid tripling the window-lifecycle bookkeeping (focus, secondary-display Space handling, close semantics) already spent real debugging effort on for the Overlay and Chat Panel (see decisions.md).
- **Open question, not yet decided**: what closing this window does — quit the app, or hide it while the app (and hotkey) keeps running in the background, the way a menu-bar/dock-icon utility usually behaves. Nothing genuinely persistent existed before this, so the question is new; flagged in decisions.md, not resolved here.

**Settings page**:
- Hotkey — changing it requires a real hold-drag-release gesture test before saving, not a static validity check. Reuses this project's own "registration success proves nothing" lesson (decisions.md): a candidate accelerator can register cleanly via `globalShortcut.register()` and still fail for reasons no static check catches. Failure/timeout behavior during that test is explicitly not yet decided.
- Display name — local-only field, explicitly **not** authentication. Real user auth stays exactly as already scoped at Phase 7 (Supabase Auth), unaffected by this.
- Theme — Electron's `nativeTheme` API + CSS `prefers-color-scheme`, light/dark/system. Both already built into Electron/Chromium, no new dependency.
- Dictation language — swaps the whisper.cpp model off `base.en` to a multilingual model. Reopens the already-flagged model-size tradeoff (todo.md) rather than being independent of it; needs its own accuracy verification pass per language actually offered, not assumed to work from architecture alone.
- App language / full i18n — shown disabled ("coming soon") rather than omitted or silently built. Deferred because translation debt scales with a UI surface that's still actively changing.
- Data and privacy — capture storage location + an open-folder action + a clear-all action. Justified by the pre-existing privacy-first constraint (§1: "no silent capture, no unnecessary retention"), not new scope — this makes that commitment visible and actionable.

**Captures page**: reads `conversations.jsonl` (§5), reverse-chronological list — thumbnail, first question, timestamp, and a feedback icon if `feedback` is set on that record.

**Help page**: a static in-app usage guide (hotkey, basic flow). No external link — no marketing/support site exists yet (see decisions.md).

---

## 4. Data flow (sequence)

```
User presses the hotkey, keeps it held
   │
   ▼
Hotkey Listener → activates Selection Overlay, which takes focus immediately
   │
   ▼
User drags a box with the mouse while still holding the key, releases the key
   │
   ▼
Selection Overlay → bbox coordinates (from last drag position) → Screen Capture
   │
   ▼
Screen Capture → crop.png + full.png saved to temp dir
   │
   ▼
Chat Panel opens (now the focused window), text field focused, history empty
   │
   ▼
  ┌─────────────── loop while panel is open ───────────────┐
  │                                                          │
  │  User types a message, hits Enter                       │
  │       OR                                                 │
  │  User holds the same key again (now a window-scoped      │
  │  event, not global), speaks, releases → whisper.cpp      │
  │  transcribes the clip on-device → text lands in field    │
  │                                                          │
  │  ▼                                                       │
  │  Response Handler → askAboutRegion(crop.png, history)    │
  │  ▼                                                       │
  │  Vision Model Client → Mistral API call                  │
  │       ├── success → answer appended to Chat Panel history│
  │       └── failure → error shown in panel, retry option   │
  │                                                          │
  └── user may send another follow-up (loop) or close ──────┘
                        │
                        ▼
        User closes the panel → conversation ends
                        │
                        ▼
        Local Logger writes the full turn history once
```

---

## 5. Data model

One record per **conversation** (not per turn) — a session can have multiple back-and-forth turns, all sharing the same image and logged together once the panel closes:

| Field | Type | Notes |
|---|---|---|
| `id` | string (uuid) | unique per conversation/session |
| `image_crop` | path | the circled/boxed region |
| `image_context` | path or null | full screenshot, optional |
| `app_hint` | string or null | active app at capture time |
| `turns` | array | ordered list of `{role: "user"\|"assistant", content: string}` |
| `category` | enum | code / chart / ui / text / math / translation |
| `feedback` | enum or null | thumbs_up / thumbs_down / none — captured once, for the conversation as a whole |
| `source` | enum | real_usage / synthetic |
| `started_at` / `ended_at` | datetime | session bounds |

**This is a change from earlier drafts**, which logged one flat record per single question/answer pair. Multi-turn sessions need turns nested under a shared conversation, or Phase 3's dataset curation can't tell which turns belonged together. `data_pipeline.md` and the `dataset-pipeline` skill need a matching update — flagged in `.claude/memory/todo.md`.

---

## 6. Non-functional requirements

| Concern | Target / approach |
|---|---|
| **Latency** | Chat panel should show a loading state immediately after each submit, dominated by the Mistral round-trip; never feel frozen |
| **Privacy** | No screen content leaves the device without the active query; no background/continuous capture; visual indicator whenever capture is active |
| **Reliability** | Network/API failures degrade gracefully — never crash, always show *something* (error + retry) in the panel |
| **Security** | API key stored in OS credential store or local config, never hardcoded or logged |
| **Offline behavior** | Since Phase 1 depends on hosted Mistral, no connectivity = clear "offline" message in the panel, not a silent hang |

---

## 7. Failure modes & handling

| Failure | Handling |
|---|---|
| No internet / Mistral unreachable | Chat panel shows "Couldn't reach the model — check your connection" + retry button |
| Mistral rate limit hit | Panel shows "Too many requests, try again in a moment"; consider local backoff/queue if this becomes frequent |
| OS denies screen recording / accessibility permission | On first launch, show an explanation screen *before* the OS prompt, so the user understands why it's needed |
| Empty/malformed model response | Panel shows "Didn't get a usable answer — try rephrasing" rather than displaying garbage, conversation stays open to retry |
| User selects a 0px or off-screen region | Overlay validates bbox before capture; ignore releases below a minimum size threshold |
| Freeform path drifts past screen edges during the drag | Clamp the live bounding box to screen bounds continuously, not just at capture time |
| Elongated/sprawling lasso path produces a much bigger box than intended | Live bbox preview (see §3.2) lets the user see and self-correct in real time — no rejection logic needed |
| User closes the panel mid-request | Cancel the in-flight request if possible; don't log a partial/broken conversation |

---

## 8. Deployment view

**Now (Phase 1–6)**: single-user local app. Only external dependency is the Mistral API call (or, once fine-tuned, a fully local model — zero network dependency at that point).

**Later (Phase 7, real users)**: client-server split, backed by Supabase (Postgres + Auth + Storage + Edge Functions) —

```
Desktop Client (thin)
       │
       ▼
Supabase Edge Function — auth check, rate limiting, routing
       │
       ▼
Inference — routes to Mistral / fine-tuned model serving
       │
       ▼
Model Serving (serverless GPU, autoscaled)

(Supabase Postgres holds users/usage/billing status throughout — not a separate hop, queried directly by the Edge Function)
```

The `askAboutRegion()` contract stays the same on the client — it just starts pointing at your Supabase project's Edge Function URL instead of calling Mistral directly, so the client code barely changes even at this transition. Full detail in `implementation_plan.md` Phase 7.

---

## 9. Open design questions to revisit

- ~~Bounding-box vs. freeform lasso~~ — **Resolved**: freeform gesture in the UI, but capture always uses the bounding box of the path, not a true polygon mask (see §3.2 and decisions.md)
- ~~Whether `image_context` (full screenshot) should always be sent~~ — **Resolved**: hybrid — a cheap downscaled thumbnail every call, plus a tool the model can invoke for full-resolution when needed (see §3.5 and decisions.md)
- ~~Where the API key lives once this is packaged for distribution~~ — **Resolved**: local env var (or Electron's `safeStorage` for extra polish) through Phase 1–6, since only you have the app; moves to the Supabase Edge Function environment at Phase 7, never shipped to the client — a packaged app can always be inspected by whoever's running it, so anything embedded in it isn't actually secret once strangers have a copy (see decisions.md)
- ~~How long a conversation can get before cost-per-follow-up becomes a real concern~~ — **Resolved**: no artificial limit, full history held for the whole session (see decisions.md). `mistral-small-latest`'s 262K-token context window makes this a non-issue in practice for realistic session lengths; the cost tradeoff already logged stands as-is, not engineered around