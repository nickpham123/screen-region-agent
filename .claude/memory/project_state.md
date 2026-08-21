# Project State

Snapshot of what actually exists right now, not what's planned. Update this whenever something is built, not when something is merely discussed.

## Superseded — Python/PyQt prototype (do not build on this)

These files exist in the project directory from before the Electron decision. Left in place for reference, not deleted, but **the go-forward plan does not use them**:

- `capture.py`, `hotkey_listener.py`, `overlay.py`, `popup.py`, `main.py`, `requirements.txt`

See `.claude/memory/decisions.md` — "App shell: Electron" — for why. Safe to delete these once the Electron version reaches equivalent functionality; keep until then in case anything is worth referencing.

## Built and working

- `mistral_vision_query.py` — Python reference implementation of the **single-turn** vision call, `ask_about_region(image_path, question) -> str`, calls Mistral's `mistral-small-latest`. Note: the actual contract needed now is multi-turn (`askAboutRegion(imagePath, conversationHistory)`, see decisions.md) — this file is reference for the core request logic, the JS port needs to extend it to carry conversation history, not just translate it 1:1.
- Electron app scaffold (`main.js`, `index.html`, `package.json`) — main process creates one `BrowserWindow` (`contextIsolation: true`, `nodeIntegration: false`), loads `index.html`. Verified: `npm start` launches the app and shows the window.
- `globalShortcut` hotkey listener — accelerator is **`Control+1`**, chosen after testing seven candidates hands-on (11/11 activations, zero failures). Unregisters on activation and re-registers on finalize. The main process sends the trigger key's code to the overlay on activation, so the accelerator and the renderer's keyup check can't drift apart. **Usability note**: the modifier must be pressed slightly before the trigger key — macOS only matches a global accelerator when the modifier is already down.
- Selection Overlay (`overlay.html`, `overlay.js`, `preload.js`) — transparent frameless full-screen `BrowserWindow` **repositioned to whichever display holds the cursor at activation** (single window, moved per-activation; not one overlay per display). Marked `setVisibleOnAllWorkspaces` so it can take keyboard focus on a secondary display's Space. Takes focus on activation, shows a "Release to select" badge, draws a freeform cursor trail on a canvas while the key is held, accumulates a bounding box (computed, not rendered), and finalizes on the trigger key's release. Includes click-to-reset (clears the trail mid-gesture with a flash cue), minimum-size validation, and screen-edge clamping. Drawing discards the synthetic activation mousemove and anchors on the next real one, so no phantom trail is drawn and a selection begins where drawing actually started. Verified across repeated runs: deliberate holds (including 8-20s), fast taps, and press-while-still-moving all behave correctly.
- Stuck-gesture safety net, now a **liveness watchdog** — the renderer forwards the held trigger key's auto-repeat `keydown`s as a `gesture-alive` ping, re-arming a 5s main-process timer. It therefore fires on 5s of *silence*, never on gesture length, so an active hold can't be truncated at any duration; a genuinely stuck gesture is still force-closed with both processes reset (renderer state cancelled via IPC, overlay hidden, hotkey re-registered). Replaced a fixed 5s deadline that was cutting off real in-progress holds. Degrades to the old behavior if macOS key repeat is set to Off.

## Known unreliable

- **Releasing the hotkey within ~445ms** loses the gesture — deterministic, not intermittent. `globalShortcut` consumes the trigger key's original keydown, so the overlay is blind to the key until macOS auto-repeat starts (~445ms measured); a key the window never saw yields no keyup either. Bounded to ~2.5s by the initial-liveness deadline. Fully explained — see decisions.md's consolidated hold/release section §1.
- ~~Focus instability on activation~~ — **retracted 2026-08-21**, was an artifact of multiple Electron instances competing for the accelerator and focus during testing. Confirmed directly: one keypress logged by five separate instances within 2ms. Clean single-instance measurement: `isFocused` `true` on 32 of 33 gestures, vs `false` on 6 of 8 contaminated. See decisions.md §4.
- **Selection overlay is deaf whenever the hotkey is unregistered.** The accelerator comes off for the whole duration of a gesture including a hung one, so hotkey presses during that window do nothing. Now bounded to ~2.5s rather than 5s, but not eliminated.

- Single-instance lock (`app.requestSingleInstanceLock()`, acquired before `app.whenReady()`) — a second launch exits before creating a window or registering the accelerator, logging the `pkill` recovery command; the primary logs the blocked attempt and shows no UI. Guards a confirmed failure mode where concurrent instances all registered the same accelerator and fought over focus. Tested by deliberate double-launch. Marked in code as the hook where Step 5 should focus the Chat Panel instead.

## Planned but not built (current design)
- **Step 4 — `desktopCapturer`-based screen capture + crop logic (next unstarted item)**
- **Chat Panel** — merged question+answer interface, multi-turn, text + voice input (voice via `whisper-node-addon`/whisper.cpp, on-device, held with the same key used for region selection)
- JS port of `askAboutRegion(imagePath, conversationHistory)` (Mistral API call via HTTP, multi-turn)
- Local logging module — schema is now per-conversation with nested turns, not per-question (see `data_pipeline.md`), no code yet
- Synthetic data generation script (scaffolded conceptually, not implemented)
- Any Swan/SLURM job scripts
- Any fine-tuning code (`train_lora.py` referenced in docs as illustrative, doesn't exist yet)
- Anything Phase 7 (Supabase project, Edge Functions, desktop app packaging/signing) — correctly not started, real users are far off

## Documentation that exists

- `CLAUDE.md` — mentor mode + Karpathy-derived behavioral guidelines + project orientation
- `implementation_plan.md` — full phase-by-phase plan, tooling updated to Electron, Phase 7 updated to Supabase with a real deployment plan
- `system_design_plan.md` — architecture/components/data flow/failure modes, updated for the Chat Panel + multi-turn contract
- `data_pipeline.md` — data flow from capture through fine-tuning and back, schema updated to per-conversation
- `skills/vision-backend/SKILL.md`, `skills/dataset-pipeline/SKILL.md`, `skills/swan-finetuning/SKILL.md` — first two updated for the multi-turn contract/schema; swan-finetuning unaffected (SLURM mechanics didn't change)
- `.claude/memory/` (this directory) — decisions, state, phase log, todo

## Architecture summary

Single-process Electron desktop app (main + renderer processes) today. Only external network dependency is the Mistral API call. No backend, no database — Phase 1–6 storage is local-only (SQLite/JSONL on the user's own machine). Phase 7 (if/when there are real users) adds Supabase (Postgres + Auth + Storage + Edge Functions) as the backend — explicitly not being built yet.

## Known gaps / risks

- No real usage data exists yet, so the data pipeline and fine-tuning phases are entirely unvalidated in practice
- Electron code now exists for Steps 1-2 only (scaffold + hotkey); Steps 3-8 (overlay, capture, Chat Panel, vision call, logging) are still unbuilt despite the amount of design work done — don't mistake detailed docs for built code.