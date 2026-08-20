# Project State

Snapshot of what actually exists right now, not what's planned. Update this whenever something is built, not when something is merely discussed.

## Superseded — Python/PyQt prototype (do not build on this)

These files exist in the project directory from before the Electron decision. Left in place for reference, not deleted, but **the go-forward plan does not use them**:

- `capture.py`, `hotkey_listener.py`, `overlay.py`, `popup.py`, `main.py`, `requirements.txt`

See `.claude/memory/decisions.md` — "App shell: Electron" — for why. Safe to delete these once the Electron version reaches equivalent functionality; keep until then in case anything is worth referencing.

## Built and working

- `mistral_vision_query.py` — Python reference implementation of the **single-turn** vision call, `ask_about_region(image_path, question) -> str`, calls Mistral's `mistral-small-latest`. Note: the actual contract needed now is multi-turn (`askAboutRegion(imagePath, conversationHistory)`, see decisions.md) — this file is reference for the core request logic, the JS port needs to extend it to carry conversation history, not just translate it 1:1.
- Electron app scaffold (`main.js`, `index.html`, `package.json`) — main process creates one `BrowserWindow` (`contextIsolation: true`, `nodeIntegration: false`), loads `index.html`. Verified: `npm start` launches the app and shows the window.
- `globalShortcut` hotkey listener (`Cmd+Shift+Space`, press-to-toggle — see decisions.md) — shows/focuses the Step 1 window as a **temporary** overlay stand-in (`// TEMPORARY` comment in `main.js`, swapped for the real overlay at Step 3). Verified: pressing the hotkey while a different app is focused brings the window to front with focus.

## Planned but not built (current design)

- Transparent Selection Overlay `BrowserWindow` with mouse drag-to-select, plus a "ready to select" badge on activation
- `desktopCapturer`-based screen capture + crop logic
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