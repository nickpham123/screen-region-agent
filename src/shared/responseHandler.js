// Response Handler (system_design_plan.md §3.6) — orchestrates one
// askAboutRegion() call for a turn the Chat Panel just submitted, and
// drives the IPC messages the renderer needs to react to it: a loading
// state immediately (§6's non-functional requirement — never feel
// frozen), then either the assistant's reply or a §7-mapped error message.
// Deliberately knows nothing about the DOM/UI itself — chatPanel.html owns
// rendering, this module only calls the Vision Model Client and reports
// the outcome back over IPC.

const { askAboutRegion } = require('./visionClient');

// Same timestamped-logging shape as main.js's log() — duplicated rather
// than imported/exported across the electron boundary for one trivial
// helper, same precedent as diagnostics/verify_move_file.js duplicating
// moveFile(). Without this, the single most important call in the app
// (the actual model request) was the only outcome in the whole codebase
// invisible in the terminal — every other step logs its result, this one
// silently didn't.
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// §7's failure-mode table, keyed by visionClient.js's `.code` contract —
// this is the seam Step 6 was built around, so no message-string parsing
// is needed here. 'api_error' isn't a row in §7's table (it only lists
// "no internet" and "rate limit" as the network-shaped failures) but is a
// real reachable case — any other non-2xx HTTP status from Mistral — so it
// gets a generic message rather than being left unhandled.
const ERROR_MESSAGES = {
  network: "Couldn't reach the model — check your connection.",
  rate_limit: 'Too many requests, try again in a moment.',
  malformed: "Didn't get a usable answer — try rephrasing.",
  api_error: "Something went wrong on the model's end — try again.",
};

// Takes the window and turns array as parameters rather than reaching into
// main.js's module-level state, same as captureRegion(bbox, displayId) —
// keeps this file decoupled and independently testable.
//
// Returns { controller, done }: `controller` is the AbortController driving
// this call, so the caller (main.js) can cancel it if the panel closes
// mid-request (§7's cancel-on-close case); `done` is a promise that
// settles (never rejects) once the call has fully finished, success or
// failure — main.js uses it to know when it's safe to clear its
// "call in flight" tracking, so a second turn isn't permanently blocked
// by the first one having already completed.
function handleUserTurn(chatPanelWindow, cropPath, turns) {
  const controller = new AbortController();

  log(`Vision call starting (${turns.length} turn(s) in history)`);
  chatPanelWindow.webContents.send('chat-loading-start');

  const done = askAboutRegion(cropPath, turns, { signal: controller.signal })
    .then((answerText) => {
      log('Vision call succeeded:', JSON.stringify(answerText));
      if (chatPanelWindow.isDestroyed()) return; // panel closed before the reply arrived
      const assistantTurn = { role: 'assistant', content: answerText };
      turns.push(assistantTurn);
      chatPanelWindow.webContents.send('chat-assistant-reply', assistantTurn);
    })
    .catch((err) => {
      // Deliberate cancel (panel closed mid-request) — not a real failure,
      // nothing to show the user, and per §7 nothing gets logged either
      // (turns is left as-is: still ending on the unanswered user turn).
      if (err.code === 'cancelled') {
        log('Vision call cancelled (panel closed mid-request)');
        return;
      }
      log(`Vision call failed [${err.code}]:`, err.message);
      if (chatPanelWindow.isDestroyed()) return;
      const message = ERROR_MESSAGES[err.code] || 'Something went wrong — try again.';
      chatPanelWindow.webContents.send('chat-error', message);
    });

  return { controller, done };
}

module.exports = { handleUserTurn };
