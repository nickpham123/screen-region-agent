# Screen-Region AI Agent

A macOS desktop tool: hold a hotkey, circle a region of the screen with the cursor, then have a short back-and-forth chat about it — type or speak, follow-up questions keep context — until you close the panel.

Long-term goal: move off a hosted vision API and onto a fine-tuned, locally-served open vision model (Qwen2.5-VL-7B via QLoRA).

## Status

Early prototype. Currently built and working:

- Electron app scaffold (`main.js`, `index.html`, `package.json`)
- Global hotkey listener (`Cmd+Shift+Space`, press-to-toggle)
- `mistral_vision_query.py` — Python reference implementation of the single-turn vision call, being ported to JS

Not yet built: the selection overlay, screen capture/crop, the chat panel UI, the JS multi-turn vision backend, and local logging. See `.claude/memory/project_state.md` for the current up-to-date snapshot.

## Architecture

Single-process Electron app (main + renderer). The only external dependency today is the Mistral API (`mistral-small-latest`). All vision calls go through one stable contract:

```
askAboutRegion(imagePath, conversationHistory) -> answerText
```

Client code (hotkey/overlay/capture/chat panel) only ever calls this — never a model SDK directly — which is what keeps the vision backend swappable later without touching the rest of the app.

## Setup

```bash
npm install
npm start
```

Requires a Mistral API key (see `mistral_vision_query.py` for the reference call).

## Docs

- `CLAUDE.md` — project orientation and working conventions, start here
- `.claude/memory/project_state.md` — what's actually built vs. planned
- `.claude/memory/decisions.md` — locked-in decisions and why
- `.claude/memory/phase_log.md` — status per implementation phase
- `.claude/memory/todo.md` — concrete next actions
- `implementation_plan.md` — full phase-by-phase plan
- `system_design_plan.md` — architecture, components, data flow, failure modes
- `data_pipeline.md` — data flow from capture through fine-tuning and back
- `skills/` — reusable procedures (swapping backends, dataset curation, fine-tuning jobs)
