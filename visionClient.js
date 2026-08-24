// Vision Model Client (system_design_plan.md §3.5) — JS port of
// mistral_vision_query.py's ask_about_region(), extended to carry
// conversation history instead of a single question. This is the one
// contract CLAUDE.md calls out as a deliberate abstraction (load-bearing
// for the Phase 4-6 backend swap) — keep the shape stable.
//
//   askAboutRegion(imagePath, conversationHistory) -> Promise<answerText>
//
// Contract on conversationHistory (stated explicitly, per review): every
// turn is always a plain { role, content: string } — content is never
// pre-wrapped into Mistral's image-parts array. That wrapping is this
// module's own private concern, applied fresh to turn 0 on every call; the
// caller (main.js/Chat Panel) never needs to know Mistral-specific shapes
// exist. This is what keeps the array safe to log, re-send, and eventually
// hand to a completely different backend unchanged.

const fs = require('fs');
const path = require('path');
// Loads MISTRAL_API_KEY from a local .env file (see decisions.md) —
// populates process.env as a side effect of requiring this module, so
// nothing that requires visionClient.js — directly (this diagnostic) or
// transitively via responseHandler.js (main.js) — needs its own separate
// loading step. .env is gitignored, never committed.
require('dotenv').config();

const MODEL_ID = 'mistral-small-latest';
const CHAT_COMPLETIONS_URL = 'https://api.mistral.ai/v1/chat/completions';

// No prior network-call precedent in this codebase to match, so picked
// deliberately rather than left as a bare guess: comfortably above a real
// vision call's typical latency (image + multi-turn text through a small
// model), but short enough that a genuinely unreachable API reads as
// "failed" within the session rather than an indefinite hang. Revisit if
// real usage shows longer calls legitimately timing out.
const REQUEST_TIMEOUT_MS = 30_000;

function getApiKey() {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error(
      'MISTRAL_API_KEY environment variable is not set. Get a key at https://console.mistral.ai'
    );
  }
  return apiKey;
}

function mimeTypeFor(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  return ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
}

function encodeImageDataUri(imagePath) {
  const b64 = fs.readFileSync(imagePath).toString('base64');
  return `data:${mimeTypeFor(imagePath)};base64,${b64}`;
}

// Builds Mistral's messages array from conversationHistory, attaching the
// image to turn 0 unconditionally. Rebuilt fresh on every call (the API is
// stateless), which is exactly what makes "attach to turn 0" sufficient —
// no separate "have I sent the image yet" bookkeeping needed, since turn 0
// is present in the array on every call regardless of how many turns have
// accumulated since.
function buildMessages(imagePath, conversationHistory) {
  return conversationHistory.map((turn, i) => {
    if (i !== 0) return { role: turn.role, content: turn.content };
    return {
      role: turn.role,
      content: [
        { type: 'image_url', image_url: encodeImageDataUri(imagePath) },
        { type: 'text', text: turn.content },
      ],
    };
  });
}

// Failures are thrown as Errors carrying a `.code`, so the Response
// Handler (Step 7, system_design_plan.md §3.6) can route to the exact
// user-facing message in §7's failure-mode table without re-parsing a
// message string. This module deliberately does not format any UI text
// itself — that's the Response Handler's job, not the Vision Model
// Client's.
function apiError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

// `signal` (optional, Step 7): lets the caller cancel an in-flight call —
// e.g. the Chat Panel closing mid-request, per system_design_plan.md §7's
// "user closes the panel mid-request" row. Chained into the same
// AbortController that already drives the timeout, so either source aborts
// the same fetch; the catch block below tells them apart by checking
// whether the *external* signal specifically was the one that fired.
async function askAboutRegion(imagePath, conversationHistory, { signal: externalSignal } = {}) {
  const apiKey = getApiKey();
  const messages = buildMessages(imagePath, conversationHistory);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort);
  }

  let response;
  try {
    response = await fetch(CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: MODEL_ID, messages }),
      signal: controller.signal,
    });
  } catch (err) {
    // A deliberate external cancel gets its own code, distinct from a real
    // network failure or our own timeout — the caller needs to tell "this
    // was cancelled on purpose" apart from "this actually failed" so it
    // knows not to show an error or log anything (see responseHandler.js).
    if (externalSignal?.aborted) {
      throw apiError('cancelled', 'Request was cancelled.', err);
    }
    throw apiError('network', 'Could not reach the Mistral API.', err);
  } finally {
    clearTimeout(timeout);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }

  if (response.status === 429) {
    throw apiError('rate_limit', 'Mistral API rate limit hit.');
  }
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw apiError(
      'api_error',
      `Mistral API returned HTTP ${response.status}.`,
      bodyText
    );
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw apiError('malformed', 'Mistral API response was not valid JSON.', err);
  }

  const answerText = data?.choices?.[0]?.message?.content;
  if (typeof answerText !== 'string' || answerText.trim() === '') {
    throw apiError('malformed', 'Mistral API response had no usable answer text.');
  }

  return answerText;
}

module.exports = { askAboutRegion };
