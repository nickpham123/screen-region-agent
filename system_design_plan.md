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
- **Note on the hold-to-select gesture**: `globalShortcut` alone has no keyup event — a long-standing Electron limitation. The workaround: the moment the press fires, the Selection Overlay window appears and takes OS keyboard focus immediately. From that instant, the *same* physical key is tracked via ordinary window-scoped `keydown`/`keyup` (not `globalShortcut`), which works completely normally, including release. So the user genuinely holds one key through the whole select gesture — the two-stage detection (global press → window-scoped hold/release) is an implementation detail, invisible to the user.

### 3.2 Selection Overlay
- **Responsibility**: render a transparent full-screen window, take focus immediately on activation, track the mouse as a freeform path while the hotkey is held, produce a bounding box on key release
- **Tech**: a transparent, click-through `BrowserWindow` + HTML/CSS/JS
- **Interface**: on hotkey release, emits `(x, y, width, height)` in screen coordinates — the bounding box (min/max X, min/max Y) of the traced path, not a true polygon mask
- **Freeform gesture, rectangular capture**: the user draws whatever shape feels natural (the whole point of "circling" something) — but on release, only the bounding box of that path is ever sent to the model. This sidesteps two problems at once: (1) vision models tokenize images as a fixed rectangular patch grid, so an irregular mask wouldn't meaningfully help the model anyway — it would just flatten excluded pixels to a solid color; (2) it means capture/crop logic stays exactly as simple as pure bounding-box, since the only new work is computing min/max over a path instead of two corners
- **Live bbox preview**: render the current bounding box as a translucent rectangle outline continuously while dragging, not just at the end. This is the fix for elongated/sprawling paths — a long scribble can bound-box into far more area than the user realizes, and seeing the box grow live lets them self-correct (draw tighter, release sooner) rather than needing rejection logic
- **Ready indicator**: the instant the overlay activates (before any drag starts), show a small floating pill/badge — outlined, translucent style — reading something like "Release to select" near the cursor. This confirms the hotkey actually registered, which matters since there's otherwise no feedback in that brief window before dragging begins. Once dragging starts, the drag rectangle itself becomes the primary visual feedback and the badge can fade out.

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