// Reproduction for the turn-3 "Couldn't reach the model — check your
// connection." failure (errors.md E-013). Replays the real 3-turn chat
// verbatim against one capture through the real askAboutRegion(), building
// each turn's history from the model's own previous answers, the same way
// the Chat Panel does.
//
// Measurement only: wraps the global fetch() that visionClient.js uses (same
// approach as compare_vision_models.js) to record elapsed, completion_tokens
// and finish_reason per call, without changing the request. A failed turn is
// re-sent once immediately, the same as the panel's Retry. If it still
// fails, that repeat stops, since later turns need the answer.
//
// The output file contains answers about the user's screen: write it to a
// scratch or gitignored path, never commit it. The console prints counts only.
//
// Requires MISTRAL_API_KEY in .env.
// Run: node diagnostics/repro_long_conversation.js <capture.png> <out.json> [--repeats N]

const fs = require('fs');
const { askAboutRegion } = require('../src/shared/visionClient');

const QUESTIONS = [
  'How do I make a similar UI like the screenshot?',
  'How should I get started',
  'What if I have programming experience, help me learn slowly step by step',
];
// ministral-14b's limit is 30 req/min (model_quota_sweep.js).
const SPACING_MS = 2500;

const realFetch = global.fetch;
let lastCall = null;
global.fetch = async (url, opts) => {
  const startedAt = Date.now();
  lastCall = { status: null, completionTokens: null, promptTokens: null, finishReason: null };
  const response = await realFetch(url, opts);
  lastCall.status = response.status;
  if (response.ok) {
    const data = await response.clone().json().catch(() => null);
    lastCall.completionTokens = data?.usage?.completion_tokens ?? null;
    lastCall.promptTokens = data?.usage?.prompt_tokens ?? null;
    lastCall.finishReason = data?.choices?.[0]?.finish_reason ?? null;
  }
  lastCall.fetchMs = Date.now() - startedAt;
  return response;
};

async function callOnce(imagePath, history) {
  lastCall = null;
  const startedAt = Date.now();
  try {
    const answer = await askAboutRegion(imagePath, history);
    return { ok: true, answer, elapsedMs: Date.now() - startedAt, ...lastCall };
  } catch (err) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      code: err.code,
      causeName: err.cause?.name ?? null,
      causeCode: err.cause?.cause?.code ?? null,
      ...lastCall,
    };
  }
}

function summarize(r) {
  if (r.ok) {
    return `OK  ${r.elapsedMs}ms  completion_tokens=${r.completionTokens}  prompt_tokens=${r.promptTokens}  finish_reason=${r.finishReason}`;
  }
  return `FAIL [${r.code}] ${r.elapsedMs}ms  cause=${r.causeName}${r.causeCode ? `/${r.causeCode}` : ''}  status=${r.status ?? 'none'}`;
}

async function main() {
  const args = process.argv.slice(2);
  const repeatsIdx = args.indexOf('--repeats');
  const repeats = repeatsIdx === -1 ? 3 : Number(args.splice(repeatsIdx, 2)[1]);
  const [imagePath, outPath] = args;
  if (!imagePath || !outPath || !fs.existsSync(imagePath)) {
    console.error('Usage: node diagnostics/repro_long_conversation.js <capture.png> <out.json> [--repeats N]');
    process.exit(1);
  }

  const results = [];
  for (let rep = 1; rep <= repeats; rep++) {
    const history = [];
    for (let turn = 1; turn <= QUESTIONS.length; turn++) {
      history.push({ role: 'user', content: QUESTIONS[turn - 1] });
      const attempts = [await callOnce(imagePath, history)];
      console.log(`rep ${rep} turn ${turn}: ${summarize(attempts[0])}`);
      if (!attempts[0].ok) {
        attempts.push(await callOnce(imagePath, history));
        console.log(`rep ${rep} turn ${turn} retry: ${summarize(attempts[1])}`);
      }
      results.push({ rep, turn, question: QUESTIONS[turn - 1], attempts });
      const answered = attempts.find((a) => a.ok);
      if (!answered) break;
      history.push({ role: 'assistant', content: answered.answer });
      await new Promise((r) => setTimeout(r, SPACING_MS));
    }
  }
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nWrote ${results.length} turn records to ${outPath}`);
}

main();
