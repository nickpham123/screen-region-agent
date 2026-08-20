---
name: vision-backend
description: Use this skill whenever adding, swapping, or debugging a vision model backend for the screen-region agent (Mistral now, fine-tuned Qwen2.5-VL later, or any future model). Covers the required function contract and how to keep the client decoupled from any specific model SDK.
---

# Vision Backend Skill

## The contract

Every vision backend — no matter which model or API it calls — must expose exactly this function signature:

```js
async function askAboutRegion(imagePath, conversationHistory) {
  // conversationHistory: array of { role: "user" | "assistant", content: string }
  // Returns: the next assistant answer (string)
}
```

This is **multi-turn** — `conversationHistory` is the full running list of turns for the current chat panel session (first call has one user turn; each follow-up includes everything before it). This is the seam between the desktop client (hotkey/overlay/capture/chat panel) and whatever's answering the question. Nothing upstream of this function should know or care which model/API is behind it.

Note: `mistral_vision_query.py`'s Python `ask_about_region(image_path, question)` is the **single-turn** reference — it has the right request-building logic but not the history-handling shape. Porting it means extending it to accept and pass through the conversation array, not a 1:1 translation.

## Adding a new backend

1. Create a new file implementing `askAboutRegion(imagePath, conversationHistory)` with that exact signature
2. Handle auth/setup lazily (load client on first call, cache it — don't do slow setup at import time)
3. Test standalone with a small script before wiring it into the client — call it with a 1-turn history, confirm a sane answer, then a 2-turn history, confirm the second answer actually uses context from the first
4. Only after it works standalone, swap it into the client — this isolates backend bugs from client bugs

## Swapping the active backend

Since every backend shares the same signature, switching is a one-line import change wherever `askAboutRegion()` is called. Never let backend-specific details (API keys, model IDs, request formats) leak into the client/overlay/chat panel code.

## Current backend status (check `.claude/memory/decisions.md` for the latest)

- **Active**: `mistral_vision_query.py` (Python reference) being ported to JS as the multi-turn version — Mistral API, `mistral-small-latest`
- **Evaluated and dropped**: local MLX backend, Hugging Face Inference Providers backend — both were built and compared, then explicitly deprioritized in favor of Mistral-only for Phase 1. Don't reintroduce without the user explicitly asking.
- **Planned**: fine-tuned Qwen2.5-VL-7B backend (local/self-hosted via Ollama or vLLM), once Phase 4–6 fine-tuning is complete

## Common pitfalls

- Don't hardcode API keys — always read from environment variables, documented in the backend file's own docstring/comments
- Don't let `mime` type detection assumptions break on unexpected file extensions — default sensibly
- Watch for API/SDK signature drift — vision model APIs change fast; if a call fails with an unexpected error, check the provider's current docs before assuming the code is wrong
- Watch conversation length — every turn resends the full history plus the image, so cost/latency grows with a long session (see decisions.md's cost note on the multi-turn design)