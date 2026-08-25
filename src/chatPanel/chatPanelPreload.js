const { contextBridge, ipcRenderer } = require('electron');

// Chat Panel preload (system_design_plan.md §3.4).
contextBridge.exposeInMainWorld('chatPanelAPI', {
  // Adds one turn to this session's history. `main.js` already has the
  // listener (chatPanelWindow's onTurnAdded, scoped by sender id) — this
  // just gives the renderer a way to call it instead of using ipcRenderer
  // directly (contextIsolation is on, same reason every other bridge here
  // is this small).
  submitTurn: (turn) => ipcRenderer.send('chat-turn-added', turn),
  // Step 7 (responseHandler.js): main tells the renderer a call just
  // started, so it can show a loading state immediately (§6) rather than
  // going quiet until the reply arrives.
  onLoadingStart: (callback) => ipcRenderer.on('chat-loading-start', () => callback()),
  // The assistant's real reply, already appended to main's turns array —
  // the renderer only needs to render it, not track it independently.
  onAssistantReply: (callback) => ipcRenderer.on('chat-assistant-reply', (event, turn) => callback(turn)),
  // A §7-mapped, user-safe error message (network/rate-limit/malformed/
  // other) — never a raw error object, since the Response Handler already
  // did that translation.
  onChatError: (callback) => ipcRenderer.on('chat-error', (event, message) => callback(message)),
  // Re-attempts the last (still-unanswered) user turn after an error, per
  // §7's "retry button" — no new turn to send, main already has it.
  retryLastTurn: () => ipcRenderer.send('chat-retry'),
  // Main tells the renderer a hold-to-talk press has started. The renderer
  // bootstraps its "held" state from this signal, never from a local
  // keydown — same principle as the overlay (decisions.md): a key already
  // physically down when this context starts does not reliably fire a
  // fresh keydown, and here specifically, Digit1's original keydown is
  // consumed by the accelerator before this signal is even sent (see
  // decisions.md's 2026-08-23 chord-timing findings).
  onHoldToTalkStart: (callback) => ipcRenderer.on('hold-to-talk-start', () => callback()),
  // Main force-ended a stuck hold-to-talk session (liveness watchdog
  // fired) — mirrors the overlay's 'cancel-gesture'.
  onHoldToTalkCancel: (callback) => ipcRenderer.on('hold-to-talk-cancel', () => callback()),
  // The renderer's real Digit1 keyup is the only trusted end-of-hold
  // signal — never a timeout (see decisions.md). audioPayload is
  // { samples: ArrayBuffer, sampleRate } (raw Float32 data, no processing
  // done on this side — see main.js) or null if nothing was captured.
  holdToTalkEnd: (audioPayload) => ipcRenderer.send('hold-to-talk-end', audioPayload),
  // Auto-repeat keydown liveness ping, exact same pattern as the overlay's
  // gestureAlive.
  holdToTalkAlive: () => ipcRenderer.send('hold-to-talk-alive'),
  // Main finished transcribing (or decided not to) — three distinct
  // outcomes, each with its own signal rather than one generic "done":
  onHoldToTalkTranscript: (callback) => ipcRenderer.on('hold-to-talk-transcript', (event, text) => callback(text)),
  onHoldToTalkTooShort: (callback) => ipcRenderer.on('hold-to-talk-too-short', () => callback()),
  onHoldToTalkError: (callback) => ipcRenderer.on('hold-to-talk-error', (event, message) => callback(message)),
  // Routes renderer-side logging to the main process terminal, same as
  // overlayAPI.debugLog.
  debugLog: (msg) => ipcRenderer.send('debug-log', msg),
  // Phase 2.1: sends the current feedback state ({feedback, note}) to
  // main, which just stores the latest value in its per-session closure —
  // same "renderer sends, main is the source of truth at close" shape as
  // submitTurn above. Sent on every change (button click, note keystroke),
  // not just once, so whatever's in main's closure at close time is always
  // current regardless of how the panel actually closes.
  setFeedback: (payload) => ipcRenderer.send('chat-feedback-set', payload),
});
