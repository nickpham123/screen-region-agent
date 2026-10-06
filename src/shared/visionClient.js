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

// [vision-diag] — logging only, added to diagnose a real HTTP 429 after a
// whole-screen capture (errors.md E-001). The 429 branch below used to
// throw without reading the body or headers, so which limit tripped was
// unknowable. Same timestamped shape as responseHandler.js's log().
function diagLog(...args) {
  console.log(new Date().toISOString(), '[vision-diag]', ...args);
}

// Width/height straight from the PNG IHDR chunk (bytes 16-23) — every
// crop this app writes is a PNG (capture.js), so no image library needed
// just to log two numbers. null for anything else.
function pngDimensions(buf) {
  const PNG_SIGNATURE = '89504e470d0a1a0a';
  if (buf.length < 24 || buf.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Every header on a failed response (not just a rate-limit-name filter —
// an unexpected header name shouldn't be able to hide the evidence); only
// the rate-limit ones on success, to see how close a normal call runs.
function headersToObject(headers, filter) {
  const out = {};
  for (const [name, value] of headers) {
    if (!filter || filter.test(name)) out[name] = value;
  }
  return out;
}
const RATE_LIMIT_HEADER = /ratelimit|retry-after/i;

let lastRequestStartedAt = null;

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

  const imageBuf = fs.readFileSync(imagePath);
  const now = Date.now();
  const body = JSON.stringify({ model: MODEL_ID, messages });
  diagLog('request:', JSON.stringify({
    imageBytes: imageBuf.length,
    imagePixels: pngDimensions(imageBuf),
    requestBodyBytes: Buffer.byteLength(body),
    turns: conversationHistory.length,
    msSinceLastRequest: lastRequestStartedAt === null ? null : now - lastRequestStartedAt,
  }));
  lastRequestStartedAt = now;

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
      body,
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

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    diagLog('non-2xx response:', JSON.stringify({
      status: response.status,
      body: bodyText,
      headers: headersToObject(response.headers),
    }));
    if (response.status === 429) {
      // A 429 can mean "slow down" (transient) or "this key has no quota
      // for this model at all" (permanent) — errors.md E-001 was the
      // latter, signalled by an x-ratelimit-limit-* header of "0". Retrying
      // can never succeed there, so it gets its own code rather than
      // rate_limit's "try again in a moment".
      const zeroLimit = [...response.headers].some(
        ([name, value]) => /^x-ratelimit-limit-/i.test(name) && value.trim() === '0'
      );
      if (zeroLimit) {
        throw apiError('quota_zero', `This API key has no quota for model ${MODEL_ID}.`);
      }
      throw apiError('rate_limit', 'Mistral API rate limit hit.');
    }
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
  diagLog('2xx response:', JSON.stringify({
    status: response.status,
    usage: data?.usage ?? null,
    rateLimitHeaders: headersToObject(response.headers, RATE_LIMIT_HEADER),
  }));

  const answerText = data?.choices?.[0]?.message?.content;
  if (typeof answerText !== 'string' || answerText.trim() === '') {
    throw apiError('malformed', 'Mistral API response had no usable answer text.');
  }

  return answerText;
}

module.exports = { askAboutRegion };
