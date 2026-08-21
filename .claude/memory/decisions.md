# Decisions

> **Read this first if you are touching the hotkey, the overlay, or any hold-to-X gesture:**
> [Hold/release detection on macOS + Electron — the whole mechanism](#holdrelease-detection-on-macos--electron) below the table.
> It is one consolidated explanation, written because this took a full session of
> debugging to work out and the table rows alone read as a pile of sequential
> corrections. Step 5's hold-to-talk inherits all of it.

Locked-in project decisions and why. Don't re-litigate these without the user explicitly revisiting them — if a future session finds itself reconsidering one of these, that's a signal to ask rather than silently change course.

| Decision | Rationale | Status |
|---|---|---|
| Phase 1 vision backend: **Mistral API only** (`mistral-small-latest`) | Free tier is the most generous of the options evaluated; fastest path to validating the product idea | Active |
| Local MLX backend (Apple Silicon) | Built and tested, then explicitly dropped in favor of Mistral-only | Dropped — don't reintroduce without being asked |
| Hugging Face Inference Providers backend | Built and tested, then explicitly dropped in favor of Mistral-only | Dropped — don't reintroduce without being asked |
| Fine-tune target: **Qwen2.5-VL-7B** via QLoRA/Unsloth | Best open VLM for OCR/grounding at a fine-tunable size; runs on a single GPU with QLoRA | Active, Phase 4 |
| Training compute: **UNL HCC Swan** (SLURM) | Free via user's university access; shared/preemptible, so checkpointing matters | Active, Phase 4 |
| Selection shape: **bounding box**, not freeform lasso | Simpler capture/masking logic for v1 | Active, v1 |
| Output: **popup by default**, TTS opt-in | Popup works even when audio can't be on | Active |
| Stable interface: `ask_about_region(image_path, question) -> str` | Keeps the client decoupled from any specific model/API — this is what makes backends swappable | Load-bearing, don't break |
| OS target for v1 client | **macOS** | Resolved — user develops on Apple Silicon Mac |
| App shell: **Electron** (not Tauri, not native Python/PyQt) | `globalShortcut`, `desktopCapturer`, and transparent `BrowserWindow` are all built-in, well-documented Electron APIs that map directly to this app's four core needs (hotkey, capture, overlay, popup). Tauri would need custom Rust glue for capture + permissions; PyQt/pynput/mss (original plan) meant a second language stack for no benefit once Electron was on the table. Tradeoff accepted: heavier runtime footprint (Wispr Flow's own Electron build has known performance complaints) in exchange for faster path to a validated prototype. Revisit only after the product is validated and performance is a proven, not hypothetical, problem. | Active |
| Vision backend language: **ported to JS**, not a Python subprocess | Electron is already a Node process; Mistral's API is plain HTTP. Shelling out to Python would add a cross-language IPC boundary for no real benefit — violates Simplicity First. `mistral_vision_query.py`'s logic and `ask_about_region()` contract carry over 1:1, just reimplemented in JS. | Active |
| Step 2 hotkey handler targets the Step 1 placeholder window, not a new one | Step 3 is what builds the real transparent overlay `BrowserWindow`; building overlay UI early would be scope creep on Step 2. The existing blank window stands in for it — hotkey calls `.show()`/`.focus()` on it, marked with a `// TEMPORARY` comment in `main.js` — and gets swapped for the real overlay when Step 3 lands. | Active, superseded once Step 3 lands |
| Hotkey interaction: **press-to-toggle** via `globalShortcut`, not true hold/release | `system_design_plan.md` §3.1 specs the Hotkey Listener as `onSelectionStart()`/`onSelectionEnd()` (hold-down, release-up), but Electron's `globalShortcut` API only fires once per completed accelerator press — no release event exists. True hold/release would need a raw-input hook like `uiohook-napi`, which was evaluated and rejected for now: it requires macOS's Accessibility permission (a separate, heavier onboarding prompt than screen recording), is documented to crash rather than degrade gracefully when that permission is missing, and grants full system-wide input monitoring — a much broader capability than this feature needs, which sits awkwardly next to the app's privacy-first framing. Going with press-to-toggle for Step 2; will validate whether focus-grab is reliable enough when Step 3's real overlay lands, and only revisit `uiohook-napi` if that assumption actually breaks in practice. | Active, open question re: revisiting at Step 3 |
| Question input: **both typed and voice**, voice via **local whisper.cpp** (`whisper-node-addon`) | The crop alone doesn't tell the model what the user wants to know — question is inherently free-form, so both input modes matter. **Correction**: Web Speech API was initially chosen, then found to be fundamentally broken in Electron (throws a persistent "network" error — Electron's Chromium lacks the proprietary Google API key the service needs; unresolved issue since 2016). Switched to `whisper-node-addon` — prebuilt Node/Electron bindings for whisper.cpp, no native compilation needed, Metal GPU acceleration on Apple Silicon. Bonus: this also fully resolves the earlier privacy tradeoff — audio never leaves the device, no opt-in caveat needed for Phase 7. | Active |
| Hold-to-talk key: **same physical key as region selection**, held again once the chat panel has focus | Superseded a prior, overly-cautious call to use a mouse-held mic button instead. Correction: `globalShortcut`'s missing-keyup limitation only applies while no Electron window has focus. Both the selection overlay and the chat panel take focus immediately on activation, so from that point on, the same key is tracked via normal window-scoped `keydown`/`keyup` — release detection works fine. One key, one mental model, for both the select-hold and the talk-hold. | Active |
| Region selection: **hold the key through the whole drag**, not press-once-then-mouse-only | Superseded an earlier, more conservative design (press once to open overlay, mouse handles everything after). Same reasoning as above — the overlay takes focus on activation, so the hold-and-release gesture works via window-scoped events, matching the Wispr Flow-style "hold the whole time" feel more faithfully. | Active |
| Voice transcription: **record-then-transcribe-on-release**, not live streaming | whisper.cpp doesn't naturally support word-by-word live transcription — that requires a rolling-window re-transcription approach with real complexity and flicker tradeoffs. Simpler and sufficient for v1: buffer audio while the key is held, transcribe the full clip in one pass on release. | Active |
| Conversation model: **real multi-turn, scoped to one open chat panel session** | "Like a regular chatbot conversation" — follow-ups need the model to remember prior turns in the same session, so the `askAboutRegion()` contract now carries conversation history, not just one question. Explicitly NOT persisted or resumable — once the panel closes, the conversation is over; the full turn history is logged once at close, for fine-tuning data, not for browsing past chats later. Cost tradeoff accepted: longer sessions cost more tokens per follow-up than independent single-shot calls would. | Active — changes the data schema, see project_state.md/data_pipeline.md |
| Marketing/dashboard website (cluely.com-inspired) | User wants a separate site introducing the product, for later — not blocking current Phase 1 work. | Noted, deferred — not yet scoped into a phase |
| Session length: **no artificial limit** — full history held for as long as the panel is open | `mistral-small-latest` has a 262K-token context window; a realistic Chat Panel session would need dozens of turns to approach it, so a soft cap or history-trimming isn't worth engineering for now. The cost tradeoff already logged (every turn resends full history + image) still applies — this decision means it's accepted as-is, not that it's been eliminated | Active — resolves the open question in system_design_plan.md §9 |
| Selection shape, resolved: **freeform gesture, bounding-box capture** | User draws whatever shape feels natural (matches "circling" something); on release, only the bounding box of the path is captured, never a true mask. Vision models tokenize images as a rectangular patch grid, so an irregular mask wouldn't help the model and would only add real engineering complexity (canvas clipping, alpha handling) for no accuracy benefit. This gets the UX win with none of the downside — supersedes the earlier "bounding-box for v1, lasso in v2" split | Active — resolves system_design_plan.md §9's lasso question |
| Live bounding-box preview during the drag | Freeform paths can produce a much bigger box than the user intended (an elongated scribble can bound-box into most of the screen). Rendering the current bbox continuously during the drag lets the user self-correct in real time, rather than needing rejection/warning logic after the fact | **Superseded** by click-to-reset (below) — see that row for why the answer changed, reasoning kept here for the record |
| Full-screenshot context, resolved: **hybrid** — cheap downscaled thumbnail every call + a tool to escalate to full-resolution when needed | Pure tool-calling (considered first) depends on the model reliably recognizing it needs more context — smaller/cheaper models like Mistral Small aren't reliably self-aware about this, more likely to guess than ask. A cheap always-sent thumbnail removes that failure mode for the common case, since image tokens scale with resolution and a small thumbnail costs very little; the escalation tool keeps the expensive full-resolution path rare rather than eliminating it entirely | Active — resolves system_design_plan.md §9's image_context question |
| API key location, resolved: **local env var through Phase 1–6, Supabase Edge Function environment at Phase 7** | A packaged app can always be inspected by whoever's running it — Electron especially, the JS sits in an unpacked `.asar` — so anything embedded in the client bundle isn't actually secret once someone besides the developer has a copy. Fine to keep local (env var, or Electron's `safeStorage` for extra polish) while only the developer has the app; must move server-side, never shipped to the client, at the exact point the app is first distributed to anyone else | Active — resolves the last open question in system_design_plan.md §9 |
| Selection overlay: **"ready to select" indicator** on activation | No feedback currently exists confirming the hotkey registered before the drag starts — a small outlined/translucent badge ("Release to select") fills that gap, fades once dragging begins | Active |
| Fine-tuning goal, made explicit: **visual reading accuracy + response quality**, not conversational polish | Shapes what Phase 5's eval scoring actually optimizes for — a fluent answer that misreads the image is a failure, a terse correct one is a win | Active — affects eval criteria in implementation_plan.md Phase 5 |
| Phase 7 database/backend: **Supabase** (Postgres + Auth + Storage + Edge Functions) | Fully managed — no separate FastAPI service to deploy/maintain for Tier 1, Edge Functions handle the thin routing layer directly against Supabase's own Postgres | Active — supersedes the earlier generic "FastAPI backend" sketch in implementation_plan.md Phase 7 |
| Current database status: **none** | Phase 1–6 storage is local-only (SQLite/JSONL on the user's own machine, for the fine-tuning dataset) — not a real database with user accounts. A real (Supabase) database only becomes necessary at Phase 7 | Active, correctly reflects current state |
| Hold-gesture release detection, general principle: track the **non-modifier trigger key** of the chord, never the modifiers | Established concretely for Step 3 (track `Space`'s `keyup`, not `Cmd`/`Shift`, from `CommandOrControl+Shift+Space`) — modifier keys don't reliably fire clean `keyup` events across input contexts. Stated as a general rule, not a one-off, because it applies again to the Chat Panel's hold-to-talk gesture (same physical key, same window-scoped mechanism per system_design_plan.md §3.1/§3.4) | Active |
| Selection Overlay: **primary display only** for v1 | Multi-monitor support means enumerating `screen.getAllDisplays()` and handling heterogeneous origins/scale factors — real, isolated complexity not requested anywhere in current scope. Deferring costs little since it's a bounded future change (loop over displays, one overlay window per display), not an architecture rewrite. Explicit, temporary limitation — an external monitor silently won't work with the overlay until this is revisited | **Superseded 2026-08-21 — see the row below.** The prediction held, but the word "silently" turned out to be the real cost: with a second monitor attached the hotkey fired, logs looked healthy, and the overlay rendered on an unreachable screen — indistinguishable from the app being broken, and it cost a diagnosis cycle to identify |
| **Product requirement: the overlay follows the cursor's display** | The app must work on whichever screen the cursor is on at activation, regardless of where the Electron app window lives or which window last held OS keyboard focus. **Cursor position is the tracked signal, not frontmost-window/OS focus** — confirmed explicitly, not assumed. Reasoning: the core gesture is a mouse drag, so cursor position is the direct answer to "which screen is the user about to act on", more direct than window focus and implementable with one built-in Electron call (`screen.getDisplayNearestPoint`) rather than macOS Accessibility APIs, which would add a permission prompt and real plumbing for no benefit to this interaction model. Implementation: `overlayWindow.setBounds(display.bounds)` before `show()`, per activation. **Scope**: still a *single* overlay window, repositioned each time — not one overlay rendered per display simultaneously, which stays deferred. **Accepted tradeoff**: this reuses `getCursorScreenPoint()`, measured elsewhere to return a ~29px-stale position while the cursor is moving fast (see the activation-trail bug). Considered and accepted rather than overlooked — display selection only misfires if the cursor crosses a display boundary within a few ms of the keypress, and the consequence is a one-off overlay on the neighbouring screen, not a wrong crop. **Verified 2026-08-21** on a built-in Retina (1728pt logical) + external QHD (2560×1440) setup: gestures finalize on both displays, corroborated in-log by bboxes extending to x=2297, impossible on the built-in. The disambiguating case — cursor on display B while a window on display A retained focus, no click in between — was run and passed, confirming cursor position drives the choice rather than window focus; note that condition rests on direct observation, since the log records no focus state | Active — supersedes the row above |
| Hold-gesture "is the key currently down" state: **bootstrap from the activation signal, not from a local `keydown`** | A key already physically held when a window gains OS focus generally does not fire a `keydown` for that key on focus-gain — only the eventual `keyup` reliably arrives. Discovered debugging Step 3's overlay (the hotkey handler fires `app.focus({steal:true})` + shows the window while `Space` is already down as part of the triggering chord, so a window-scoped `keydown` for `Space` can't be relied on to ever arrive). Fix: treat the activation signal itself (here, the `activate` IPC message, sent only because the chord — including the trigger key — was just pressed) as proof the key is currently held, and set the "held" flag from that directly; a local `keydown` listener can still exist defensively but isn't load-bearing. Only the `keyup` is what reliably ends the gesture. Applies wherever a hold gesture starts via a focus transfer, not just here — will recur at Step 5's Chat Panel hold-to-talk (same physical key, same window-scoped mechanism per system_design_plan.md §3.1/§3.4) | Active — apply proactively at Step 5, don't rediscover |
| Hotkey accelerator simplified: **`Alt+Space`** (Option+Space), replacing the 3-key `CommandOrControl+Shift+Space` | Hands-on testing surfaced the 3-key chord as genuinely awkward to hold one-handed while the other hand drives the mouse. Checked against macOS's own default global shortcuts: `Cmd+Space` (Spotlight), `Ctrl+Space` (input source switch), and `Ctrl+Cmd+Space` (emoji viewer) are all reserved; `Alt+Space` isn't a macOS default (and is a common Spotlight-replacement binding in apps like Raycast/Alfred, a decent signal it's not a common collision either). Can't rule out a conflict with some third-party app already on the user's machine — only OS defaults were checkable here. **Flagged for later**: this should become user-configurable eventually; explicitly not in scope now | **Superseded 2026-08-21** — `Alt+Space` was silently broken, see the root-cause row below. The rationale here had a specific gap worth learning from: it checked the accelerator against macOS's reserved *global shortcuts* and stopped there. That check can't surface the actual problem, which lives one layer down in text input, not in the shortcut registry |
| Hotkey **unregister-on-activate, re-register-on-finalize** — confirmed fix for deliberate hold-drag-release | While the accelerator stays registered, macOS's global-hotkey layer claims the trigger key's `keyup` exclusively — it never dispatches as an ordinary window-scoped event, even to a window that holds real focus. Confirmed by diagnostic logging: before the fix, `AltLeft`'s keyup arrived every time while `Space`'s never did; after it, `Space`'s keyup arrives and gestures resolve. `globalShortcut.unregister()` in the activation callback releases that claim; `registerHotkey()` on finalize re-arms it. **Scope of this claim**: verified reliable for deliberate press-hold-drag-release gestures. Does NOT cover quick taps — see the row below | Active, but **its evidence base is now suspect (2026-08-21)** — the diagnostic that "confirmed" it (`AltLeft`'s keyup arriving while `Space`'s never did) was collected on `Alt+Space`, and that exact asymmetry is now explained by Option's text-input interception rather than by the accelerator holding a claim. The unregister call is still in the code and gestures work with it, so nothing is being changed on a guess — but whether it's actually load-bearing is untested on a non-Option accelerator. Cheap to settle: remove it, run the gesture protocol, see if keyups still arrive |
| **Unresolved**: quick tap-and-release intermittently loses keyboard events entirely, on a window reporting `isFocused(): true` | Distinct from the row above, and not fixed by it. On fast press-release cycles the overlay sometimes receives no `keyup` at all — at minimum `Space`'s, and in at least one confirmed instance *both* `Space` and `AltLeft` went missing in the same gesture, with `overlayWindow.isFocused()` logging `true` throughout. This is broader than the original "the accelerator claims one specific key" theory: it's keyboard events not reaching a window that reports having focus. An `UNREGISTER_SETTLE_MS = 50` buffer between `unregister()` and activating the overlay was tried on the hypothesis that the OS event pipeline hadn't caught up — **it did not fix it** (log shows the settle window fully elapsed, then the release still never arrived). Root cause still unknown | **Largely resolved 2026-08-21, downgraded from "the uiohook trigger"** — the sweeping part of this claim ("keyboard events don't reach a window reporting focus") was an artifact of the Option+Space interception, not a general Electron/macOS focus-delivery defect: on a non-Option accelerator, keyups arrive reliably and 16/22 gestures finalized. What genuinely remains is narrower but **confirmed accelerator-independent (2026-08-21)**: quick taps lose the trigger key's events on `Control+Shift+D`, and again on `Shift+Escape`, which contains no Option — so switching accelerators never addressed this and never could. Signature is consistent every time: activation fires, the overlay receives at most one `mousemove`, then no auto-repeat `keydown` and no `keyup` at all, and the watchdog force-closes ~5s later. Most likely the key is released before the overlay wins focus (focus lands ~50-100ms after activation), i.e. a race rather than lost events, but that's still unconfirmed. Risk profile unchanged and still low: a tap that fast yields a below-minimum-size selection that gets discarded anyway, and the watchdog bounds the cleanup. **Open, lower priority, and explicitly NOT the trigger for reconsidering `uiohook-napi`** — that trigger is deliberate holds losing keyups, which is not happening |
| Stuck-gesture **safety net** (`STUCK_GESTURE_TIMEOUT_MS`, currently 5s) — a mitigation, explicitly not a fix | If a gesture activates but never resolves, a main-process timer force-closes it: cancels the renderer's gesture state, hides the overlay, re-registers the hotkey. Verified working, including the renderer-reset half (`[safety-net]` → `[renderer] gesture cancelled` pairing in the log). **Two distinct claims worth keeping separate**: (1) the app is now guaranteed not to hang permanently or strand the hotkey unregistered — that's real and verified; (2) the underlying event-delivery failure above is unfixed — the safety net only bounds its damage. An earlier version of this net hid the window without notifying the renderer, which left `spaceHeld` true and the trail drawn, so movement kept drawing an already-dead gesture; both processes are now reset | Active — mitigation only, don't mistake for a fix |
| `uiohook-napi` re-weighed against confirmed evidence — **still not adopted**, but for updated reasons | The original rejection (see the "press-to-toggle" row) was made against a *hypothetical* reliability risk. It's now been re-evaluated against three confirmed `globalShortcut` failures. **What changed in its favor**: (1) it hooks the OS input layer (`CGEventTap`), *below* window focus routing — since the confirmed failure is a focus-routing failure, code not depending on focus routing can't fail that way, so it targets the actual failing layer rather than symptoms; (2) the "crashes without Accessibility permission" objection is largely obsolete — that was SnosMe/uiohook-napi issue #24, fixed via PR #51 (verify the pulled version postdates it); (3) the permission-cost objection is weaker than assumed, since Step 4 already requires a Screen Recording prompt, making this the second prompt rather than the first; `systemPreferences.isTrustedAccessibilityClient()` (confirmed current Electron API) allows checking before initializing, with graceful fallback — though the permission still needs explaining to the user, not silently failing. **What still argues against**: full system-wide keystroke visibility remains a real capability expansion for a privacy-first app — the objection with the most weight remaining; plus a native dependency adds Electron-version coupling and Phase 7 signing/notarization friction. **Why not now**: the failure only manifests on quick taps, which produce a below-minimum-size selection that's discarded anyway — no useful gesture is being lost; the safety net bounds it to a ~5s cosmetic lingering overlay with correct state reset; and the actual product gesture (deliberate hold-drag-release) is verified reliable. Also assessed: Step 5's hold-to-talk does *not* obviously inherit this risk — it has no accelerator registered and the panel already holds focus, so it's the ordinary keydown/keyup case, not the exotic activation path where every confirmed failure occurred. **Explicit triggers to revisit**: deliberate holds (not just quick taps) start losing keyups, or Step 5's hold-to-talk hits the same failure class. Either would mean the primary input mechanism is unreliable — a different decision entirely | Deferred, not dropped — **trigger 1 appeared to fire on 2026-08-21 and then did not**: deliberate holds lost keyups across 25 straight gestures, which looks exactly like the stated trigger, but the cause was a bad accelerator (Option), not a `globalShortcut` limitation. Fixed by changing the hotkey — no dependency needed. The lesson for next time this trigger seems to fire: **rule out the accelerator before concluding the mechanism is at fault**, since a trigger-key-specific OS interception is indistinguishable from "globalShortcut can't do hold/release" from the symptoms alone |
| Stuck-gesture timeout stays at **5s**, not tightened to ~4s | A shorter timeout was proposed to make discarded quick taps less noticeable, with a ~4s floor computed from observed deliberate-hold durations (2.5–3.5s). Rejected: that sample is a handful of holds by one person in a testing mindset — real usage (a careful irregular trace, a first-time user, anyone slower than a developer running verification passes) could plausibly exceed it. Truncating a genuine in-progress selection with no explanation is a much worse failure than the current cosmetic cost of a discarded tap lingering 5s. Not worth the trade on this little data | **Superseded 2026-08-21** by the liveness-watchdog row above — and the concern recorded here turned out to be well-founded and *already happening at 5s*, not just at 4s: real holds were truncated mid-draw 4 times across runs C and D. Notably, the "2.5–3.5s deliberate hold" sample this row rightly distrusted was indeed unrepresentative — observed holds reached 4.5s+ once the accelerator actually worked. The watchdog removes the tradeoff rather than re-tuning it, so no constant needs picking |
| **Root cause of the `Alt+Space` failure: never use Option (`Alt`) in a hold-gesture accelerator on macOS** | Option is macOS's special-character modifier — `Option+Space` emits a non-breaking space (U+00A0), `Option+D` emits `∂`, and so on. Any `Option+<key>` chord is routed through the text-input/composition layer, which consumes the trigger key's raw `keydown`/`keyup` before they reach a focused window. Measured: across **25 consecutive gestures** on `Alt+Space`, not one `Space` event of either kind reached the overlay — while `AltLeft`'s keyup arrived normally in the same gestures, on a window reporting `isFocused(): true`. Switching to `Control+Shift+D` gave 8/11 finalized; isolating the variable with `Control+Shift+Space` (Space back, Option gone) gave 8/11 with **zero** missing keyups, proving Space was never the problem — Option was. Generalizes past this one chord: the reserved-global-shortcut check that picked `Alt+Space` cannot detect this class of failure, so any candidate accelerator must be **empirically verified** to deliver its trigger key's keyup, not just checked against a list. **Scope limit — read this before citing the row**: it explains the `Space`-missing/`AltLeft`-arriving asymmetry on `Alt+Space` and the total failure of deliberate holds there. It does **not** explain quick-tap keyup loss, which persists unchanged on `Shift+Escape` (no Option involved) — that's a separate, accelerator-independent cause that no accelerator change has ever targeted. Do not read this row as "quick taps are fixed" | Active — verified 2026-08-21 |
| Hotkey accelerator, **resolved: `Control+1`** | Chosen after testing seven candidates hands-on (2026-08-21). Measured 11/11 activations, `Digit1`'s keyup delivered every time, zero force-closes. Two keys, comfortable left-hand reach, and `Ctrl+<digit>` is free on macOS because apps bind `Cmd+<digit>` for tab switching. Supersedes the `Control+Shift+Space` interim row below | Active |
| **Registration success proves nothing** — every accelerator must be hands-on verified | Five candidates registered cleanly via `globalShortcut.register()` and then failed, each in a *different* way: `Alt+Space` (Option → text-input/composition layer eats the trigger key), `F6` (macOS consumes bare F-keys for hardware functions; callback never fires), `` Control+` `` (registers, callback never fires — accelerator string seems not to map to the physical key), `Control+Space` (fires, but macOS's input-source switcher grabs the chord too — visible as an `IMKCFRunLoopWakeUpReliable` error — and swallows Space's events), and the three-key chords (work fine, just ergonomically poor). No static check catches any of these | Active — treat as a hard rule when picking any future accelerator |
| **Input-method interception is a recurring failure class**, not a one-off | `Alt+Space` and `Control+Space` failed the same underlying way: a macOS input-method layer sits between the OS and the window and consumes the trigger key's raw events. Option is the special-character modifier; `Control+Space` is the input-source switcher. Symptom in both cases is identical and misleading — the accelerator fires, the window has focus, and no key events ever arrive. **Check this first** when a new accelerator misbehaves, before suspecting focus, `globalShortcut`, or the code | Active |
| **Focus instability on activation was a real defect** — recorded 2026-08-21 as "the largest remaining source of failed gestures" | Measured `isFocused()` flipping within single gestures (`true`→`false` at +200ms, and `false`→`true`), with no keyboard events arriving while mouse events kept flowing. Intended fix was to wait on the window's `focus` event before arming | **Superseded same day — see the row below.** Kept per this file's own rule: the original claim stays visible rather than being quietly overwritten, because the *way* it was wrong is the useful part |
| **Correction: focus instability was a testing artifact, not a defect** | The measurements above were taken while several Electron instances were running concurrently — each debugging round launched `npm start` without terminating the previous app, and every instance registered the same accelerator and called `app.focus({steal:true})` on its own overlay. Confirmed directly: one physical keypress at `04:48:33` is logged by **five separate instances** within 2ms, reproduced again at `02:38:05` (see §4 for raw lines). **Separate the observation from the explanation**: that all five instances fired is measured fact; *why* is inferred, not documented. Electron's `globalShortcut` docs cover only the "already taken by **other applications**" case (documented as silently failing) and say nothing about multiple instances of the same app. On macOS even that documented contract looks unreliable — electron#21975 reports `register()` succeeding and the shortcut firing anyway rather than failing silently, which fits our five `true` returns. Underlying API is Carbon `RegisterEventHotKey`; no documentation found on how it arbitrates multiple registrants. Do not cite "macOS dispatches to every registered process" as established behavior. Clean single-instance measurement: `isFocused` `true` on **32 of 33** gestures vs `false` on **6 of 8** under contamination. Lasting lesson is methodological — a global-shortcut app is unusually vulnerable to stray instances, and `register()` returns `true` for all of them with no duplicate-registration warning | Active — supersedes the row above |
| **A window moved to a secondary display needs `setVisibleOnAllWorkspaces(true)` to receive keyboard focus** | **Separate the observation from the explanation.** *Observed and reproduced* (5 of 5 consecutive gestures, run `bkr82686s` 19:48): with the overlay repositioned onto the secondary display, it rendered there and received **mouse** events normally — the trail drew under the cursor — while **zero** trigger-key events arrived, so every gesture died at the 2.5s no-key-event deadline mid-hold. *Inferred, not measured*: that the cause is macOS running a separate Space per display by default ("Displays have separate Spaces"), with `app.focus({steal:true})` granting key status to a window on the **currently active Space** — the other display's, where the Step 1 placeholder window still lives. **`isFocused` was not instrumented during the failing run**, so the focus state was never directly observed; the explanation is the best fit for "mouse arrives, keyboard doesn't, on a relocated window", and the fix derived from it eliminated the failure, but it has not been proven. To convert it to measured: instrument `isFocused`, revert the one-line fix, reproduce. Symptom was maximally misleading: the trail drew normally under the cursor and then died at the 2.5s no-trigger-key-event deadline while the key was still held, which reads as a hotkey bug rather than a focus one. Fix is one line at window creation: `overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`. **Note this is a second, separate change from the `setBounds` display-following fix, despite both landing in commit `5387246`** — different function, different lifecycle point (once at creation vs. per activation). Relocating the window's bounds does **not** fix Space assignment as a side effect, and that is established by experiment rather than argument: run `bkr82686s` had `setBounds` only and finalized **0 of 5** gestures; run `b61lzcxkk` added this single line and finalized **4 of 5**, including 10.4s and 6.3s holds. **Generalises**: any window this app shows on a display other than the active one needs the same treatment — relevant to Step 5's Chat Panel, which opens after capture and must take keyboard focus for typing. Also note the second, untried candidate fix — removing the leftover Step 1 placeholder window to eliminate the competing focus target — remains available if this recurs | Active — verified on a two-display setup 2026-08-21 |
| **Chord timing: the modifier must go down *before* the trigger key** | macOS only matches a global accelerator when the modifier flags are already set, so pressing both keys simultaneously frequently fails to activate at all. Discovered by the user after repeated "I have to press it multiple times" reports — which had been wrongly attributed to Escape's key actuation (a Touch Bar hardware theory that was wrong). This is a property of OS-level hotkey matching and applies to **every** chorded accelerator, not to any particular one. Two consequences: (1) it silently disqualified candidates during testing that were actually fine — `Control+Space` "never fired" until pressed modifier-first; (2) it's a real usability cost of chords generally, and a genuinely *new* argument for `uiohook-napi`, which does its own chord detection on raw key events and wouldn't care about press order. Not sufficient to reopen that decision, but it is a new input to it that the earlier weighings never considered | Active — note for Step 5, whose hold-to-talk uses the same chord |
| Hotkey accelerator, current: **`Control+Shift+Space`** — verified-working but explicitly interim | **Superseded 2026-08-21 by `Control+1`** (row above). | Chosen only because it isolated the Option variable and is proven to deliver Space's keyup. It reintroduces the exact ergonomic problem that got `Cmd+Shift+Space` replaced in the first place — three keys is awkward to hold one-handed while the other hand drives the mouse. A 2-key non-Option replacement is an open task; whatever is picked must clear both bars (not OS-reserved **and** empirically verified keyup delivery) | Active, interim — see todo.md |
| Accelerator configurability **promoted from "eventually" to a near-term open question** | This is the third hardcoded accelerator in three iterations (`Cmd+Shift+Space` → `Alt+Space` → `Control+Shift+Space`), each replaced for a reason the previous round didn't anticipate — ergonomics, then an OS input-layer conflict invisible to the checks being used. Continuing to hunt for one perfect global default is showing diminishing returns, and no hardcoded choice can account for third-party apps already bound on a given user's machine. Not scoping the work here, just recording that the evidence now favours making it configurable over finding a better constant | Open question — decide before Phase 7 packaging at the latest |
| Stuck-gesture safety net reworked from a **fixed deadline** into a **liveness watchdog** | The original fired 5s after activation regardless of what the user was doing, so it force-closed genuine in-progress holds mid-draw — observed 4 times across runs C and D (auto-repeat `keydown`s still streaming at the instant it fired). That's the failure the "keep 5s, don't tighten to 4s" decision was specifically trying to avoid, happening at 5s. Fix: a held key auto-repeats `keydown` every ~80ms; the renderer forwards those as a `gesture-alive` ping and the timer re-arms on each, so the timeout now measures **silence**, not elapsed duration. An active hold can't be truncated at any length; a genuinely stuck gesture is still force-closed, so the original guarantee (no permanent hang, no hotkey stranded unregistered) is unchanged. Strictly better than raising the constant, which would only have moved the truncation threshold. **Known limitation**: with macOS key repeat set to Off, no pings arrive and this degrades to the old fixed-deadline behavior | Active — supersedes the "timeout stays at 5s" row below |
| Click-to-reset: a plain click while the hotkey is still held clears the current trail/bbox tracking and starts fresh from the click point | Makes redrawing a selection cheap mid-gesture without needing to release and re-press the hotkey. Directly enables superseding the live bbox-preview rectangle (above) — once a bad/oversized path is one click away from being discarded, the always-visible box that existed specifically to help the user self-correct sprawl in real time is a redundant safety net. Whatever's accumulated since the last reset (initial activation or most recent click) is what finalizes on key release. A visible flash cue at the click point confirms the reset happened, since it would otherwise be silent | Active |

## Hold/release detection on macOS + Electron

*Consolidated 2026-08-21 from a full session of debugging. The table rows above
record individual decisions and their reversals; this is the mechanism they all
follow from. If you only read one thing before touching gesture input, read this.*

### The core problem

Electron's `globalShortcut` fires once per completed accelerator press and has no
release event. A hold gesture therefore needs two stages: the global accelerator
starts it, then the overlay window — which takes focus on activation — tracks the
same physical key with ordinary window-scoped `keydown`/`keyup`.

That handoff is where everything goes wrong, in four distinct ways. All four were
discovered separately, each initially misdiagnosed as the others.

### 1. The accelerator eats the first keydown — the root of most symptoms

`globalShortcut` consumes the trigger key's original `keydown` to fire the
accelerator. **The overlay never receives it.** The window stays completely blind
to the key until macOS's auto-repeat begins — measured at a consistent **~445ms**
on default settings — at which point repeat `keydown`s start arriving normally.

The consequence that matters: **a key the window never saw also produces no
`keyup`.** Release before auto-repeat starts and the gesture has no way to end.
It hangs until a watchdog kills it.

This single fact explains a cluster of symptoms that looked unrelated for most of
the session:
- "Quick taps intermittently lose the keyup" — not intermittent at all. It is
  deterministic: release under ~445ms, lose the gesture.
- "Sometimes pressing the hotkey does nothing" — the accelerator is unregistered
  for the entire duration of a hung gesture (see §2), so every press during that
  window is silently dead. Downstream of the same bug, not separate.
- "A tiny trail lingers for 5 seconds after a tap" — the trail is drawn correctly
  from real hand movement; what is broken is that nothing ends the gesture.

**Mitigation** (`INITIAL_KEY_DEADLINE_MS = 2500`): if no trigger-key event arrives
within 2.5s, conclude the key was released early and close immediately. Chosen over
a snappier ~1.2s because macOS's "Delay Until Repeat" can be set as slow as ~2s and
that setting exists for accessibility/motor reasons — a tighter deadline would
force-cancel genuine holds for exactly the users who need it. **Deferred
alternative**: read the real value (`defaults read -g InitialKeyRepeat`) and derive
the deadline. More precise, but shelling out plus unit conversion plus a fallback
path is real complexity for a Phase 1 prototype. Not built; revisit if 2.5s bites.

### 2. The accelerator must be unregistered during the gesture

While the accelerator stays registered, macOS's global-hotkey layer claims the
trigger key's `keyup` exclusively — it never dispatches to a window, even a focused
one. So the activation callback calls `globalShortcut.unregister()` and re-registers
on finalize.

**Caveat worth knowing**: the diagnostic that originally "confirmed" this was
collected on `Alt+Space`, and that asymmetry has a competing explanation (§3). The
unregister call is still in the code and gestures work with it, but whether it is
load-bearing is untested on a non-Option accelerator. Cheap to settle; nobody has.

### 3. Input-method layers eat the trigger key — Option is one case, not the only one

Option is macOS's special-character modifier — `Option+Space` emits U+00A0,
`Option+D` emits `∂`. Any `Option+<key>` chord is routed through the
text-input/composition layer, which consumes the trigger key's raw events entirely.
Measured: **25 consecutive gestures on `Alt+Space` delivered zero `Space` events of
either kind**, while `AltLeft`'s keyup arrived normally in the same gestures.

**`Control+Space` failed identically**, via a different input-method layer: macOS's
input-source switcher grabs the chord alongside us — visible in the log as an
`IMKCFRunLoopWakeUpReliable` error — and swallows Space's events. The accelerator
fires, the window is focused, and no key events ever arrive. So this is a **failure
class, not one bad chord**: any macOS input-method layer sitting between the OS and
the window can consume the trigger key. Check for it first when a new accelerator
misbehaves.

The trap: a reserved-global-shortcut check cannot detect any of this. `Alt+Space`
passed that check cleanly and was still completely broken. **Any candidate
accelerator must be empirically verified to deliver its trigger key's keyup**, not
just checked against a list. Two further silent failure modes found the same way:
bare F-keys are consumed by macOS hardware functions before Electron sees them
(`F6` toggled Do Not Disturb and never fired the callback), and `` Control+` ``
registered successfully but its callback never fired at all.

**Chord timing matters too**: macOS only matches a global accelerator when the
modifier is already down. Pressing both keys simultaneously frequently fails to
activate — which masqueraded as "this candidate doesn't work" for `Control+Space`
and as "this key needs a harder press" for `Escape`. Press the modifier first.

### 4. Focus instability — mostly a testing artifact, not a real defect

**This section originally claimed focus acquisition was unreliable and was the
largest remaining source of failed gestures. That was wrong, and the error is
instructive.** Those measurements were taken while *multiple Electron instances
were running simultaneously* — each `npm start` during debugging left the previous
app alive, and every instance registered the same accelerator and called
`app.focus({steal:true})` on its own overlay. The instances fought over focus.

Measured cleanly, one instance only (run `bfjomboj8`, verified sole instance in its
window): **`isFocused` `true` immediately on 32 of 33 gestures**, and the single
`false` case still finalized successfully. Under contamination (run `bwyutwf7p`) the
same measurement was `false` on **6 of 8**. Focus acquisition is fine.

**Direct confirmation, not inference** (checked 2026-08-21 when the claim was
challenged): a single physical keypress at `04:48:33` appears in **five separate
instance logs** within 2ms of itself —

```
b7s3z9kq2  04:48:33.598Z  Hotkey pressed [Shift+Escape]
bs4s3g6r3  04:48:33.597Z  Hotkey pressed [Shift+Escape]
bppia7rqz  04:48:33.599Z  Hotkey pressed [Shift+Escape]
bwyutwf7p  04:48:33.599Z  Hotkey pressed [Shift+Escape]
bve69xxpn  04:48:33.597Z  Hotkey pressed [Shift+Escape]
```

So macOS **does** dispatch one global accelerator to every registered process, each
of which then called `app.focus({steal:true})` on its own overlay. The same pattern
recurs at `02:38:05` (5 instances). That is the contamination mechanism, observed
directly. Note `globalShortcut.register()` returned `true` in every instance and no
duplicate-registration error was ever emitted — another instance of "registration
success proves nothing".

Two lasting lessons: **kill stray instances before measuring** (a global-shortcut
app is especially vulnerable, since duplicates silently compete for the same
accelerator and focus), and treat any "intermittent" finding as suspect until the
environment is known clean. A residual real effect may exist — one late-focus case
did appear — but it is rare and did not cost a gesture.

### Consequences for anything built on top of this

- **The trigger key's `keyup` is the only reliable end-of-gesture signal.** Track
  the non-modifier trigger key, never the modifiers.
- **Bootstrap "is the key held" from the activation signal**, never from a local
  `keydown` — per §1 the original keydown never arrives. Auto-repeat keydowns do
  arrive after ~445ms and are useful as a liveness signal, but they are not a
  substitute for the bootstrap.
- **Never draw from the activation point.** Two independent problems corrupt the
  first drawn segment, and both are fixed by consuming two events before drawing:
  discard the synthetic one, then anchor on the next.
  1. *The synthetic activation mousemove has bogus coordinates.* Showing the overlay
     under the cursor makes Chromium emit a mousemove 13-54ms after activation whose
     position is off by a location-dependent few pixels — deterministic and
     pixel-identical across repeated activations from a parked cursor. Left in, it
     drew a phantom trail on every activation and let taps finalize bogus selections
     (one measured at 6×31px).
  2. *The activation point itself goes stale when the cursor is moving.* It is
     `getCursorScreenPoint()` sampled at hotkey-press time. Press the hotkey while
     still moving the mouse and it is already wrong: measured 29px off from where the
     cursor was 29ms later, which drew a 29px line the instant real movement began.
     This is why the artifact appeared *only on the first gesture* — by the second the
     cursor is parked, so the activation point happens to be accurate.
  Consequence worth knowing: a selection now begins where drawing actually started,
  not where the cursor was at press time. That is the more correct behavior — the
  bbox previously included a point the user had already left.
- **`uiohook-napi` is still deferred, and its revisit trigger has not fired.** The
  trigger is *deliberate holds* losing keyups. Every failure traced back to one of
  the four causes above — accelerator choice, early release, or focus instability —
  never to `globalShortcut` being architecturally incapable. It looked like the
  trigger had fired twice this session and both times the real cause was elsewhere.
  **Rule out §1–§4 before concluding the mechanism is at fault.**

### How this was actually debugged — the method mattered more than the theories

The activation-trail bug took **four** wrong diagnoses before it broke: a residual
point from the previous gesture, a stale queued event, first-activation slowness,
and a coordinate-space mismatch between the two sources. Each was plausible, each
fit the symptom, and the first three were individually disproven by measurement.

What finally cracked it was not a better theory. It was logging the **anchor value
alongside each event** — `anchor=(858, 482)` next to `client=(862, 452)` — which made
the 29px staleness directly visible instead of inferred. Every earlier round had
instrumented the *events* while treating the anchor as ground truth. **The bug was
in the variable nobody was measuring.**

Generalisable lesson for this codebase: when several plausible theories keep half-
fitting, stop generating theories and start logging the values currently assumed
trustworthy. The same pattern showed up twice more this session — `isFocused` looked
like a real defect until a clean single-instance run showed the measurements were
contaminated, and accelerators looked broken until the user noticed press *order*
mattered.

### Things measured and confirmed correct (do not re-suspect)

- `resetTrackingPoints()` clears prior-gesture state correctly. Verified across 17
  instrumented gestures: every gesture's first mousemove referenced its own
  activation point, never the previous gesture's end. The "residual point from the
  last gesture" hypothesis was tested and **disproven**.
- The stale-queued-event hypothesis for the phantom trail was tested against event
  timestamps and **disproven** — those events land 13–54ms *after* activation, not
  before. Do not re-derive this; the fix that would have followed from it (drop
  events timestamped before activation) is a no-op.

## How to add a decision here

One row: what was decided, why (briefly), and current status (Active / Dropped / Open question / Superseded). If a decision gets reversed later, don't delete the old row — mark it Superseded and add the new row, so the history of *why* something changed is preserved.