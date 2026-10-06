// Side-by-side answer comparison across candidate vision models, for the
// MODEL_ID decision in errors.md E-001. Runs every image x question through
// each model via the real askAboutRegion() — no scoring or ranking; the
// output is for a human to judge.
//
// Model override without touching visionClient.js: askAboutRegion() has no
// model parameter and MODEL_ID must not change, so this script wraps the
// global fetch() that visionClient.js uses and rewrites only the `model`
// field of the chat-completions request body. Everything else (image
// encoding, message building, error classification) is the production code
// path. The wrapper also records status, usage, latency and rate-limit
// headers. If visionClient.js ever stops calling global fetch, the override
// would silently not apply — so each call asserts the wrapper actually ran.
//
// The output file contains the user's screen content: write it to a
// scratch or gitignored path, never commit it.
//
// Requires MISTRAL_API_KEY in .env.
// Run:
//   node diagnostics/compare_vision_models.js <png-folder> <out.md>
//        [--models id1,id2,...] [--questions-file questions.txt] [--runs N]
// questions.txt: one question per line. --runs repeats the whole grid N
// times (run is the outer loop, so a model's repeats are spread out in
// time rather than back to back). Raw results also go to <out.md>.json,
// for diagnostics/score_transcriptions.js.

const fs = require('fs');
const path = require('path');
const { askAboutRegion } = require('../src/shared/visionClient');

const DEFAULT_MODELS = ['ministral-14b-2512', 'ministral-8b-2512', 'ministral-3b-2512'];
const DEFAULT_QUESTIONS = ['What does this image show?', 'Transcribe all text you can read exactly.'];
// ministral-14b's measured limit is 30 req/min (model_quota_sweep.js), so
// stay above 2s between calls to avoid a self-inflicted 429.
const SPACING_MS = 2500;

function parseArgs(argv) {
  const args = { positional: [], models: DEFAULT_MODELS, questions: DEFAULT_QUESTIONS, runs: 1 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs') args.runs = Number(argv[++i]);
    else if (argv[i] === '--models') args.models = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--questions-file') {
      args.questions = fs.readFileSync(argv[++i], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    } else args.positional.push(argv[i]);
  }
  return args;
}

// Same IHDR read as visionClient.js's pngDimensions() — duplicated rather
// than exported, same precedent as other diagnostics here.
function pngDimensions(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 24 || buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// --- fetch wrapper: model override + measurement ---
const realFetch = global.fetch;
let overrideModel = null;
let lastCall = null;
global.fetch = async (url, opts) => {
  if (!String(url).endsWith('/chat/completions')) return realFetch(url, opts);
  const body = JSON.parse(opts.body);
  body.model = overrideModel;
  const t0 = performance.now();
  const res = await realFetch(url, { ...opts, body: JSON.stringify(body) });
  const json = await res.clone().json().catch(() => null);
  lastCall = {
    status: res.status,
    latencyMs: Math.round(performance.now() - t0),
    promptTokens: json?.usage?.prompt_tokens ?? null,
    completionTokens: json?.usage?.completion_tokens ?? null,
    rateLimit: Object.fromEntries([...res.headers].filter(([k]) => /ratelimit|retry-after/i.test(k))),
  };
  return res;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

async function main() {
  const { positional: [folder, outPath], models, questions, runs } = parseArgs(process.argv.slice(2));
  if (!folder || !outPath || !fs.existsSync(folder) || !(runs >= 1)) {
    console.error('Usage: node diagnostics/compare_vision_models.js <png-folder> <out.md> [--models a,b] [--questions-file f] [--runs N]');
    process.exit(1);
  }
  const images = fs.readdirSync(folder).filter((f) => f.toLowerCase().endsWith('.png')).sort();
  console.log(`${runs} run(s) x ${images.length} image(s) x ${questions.length} question(s) x ${models.length} model(s)`);

  const results = []; // { run, image, pixels, qIndex, model, answer, error, ...lastCall }
  for (let run = 1; run <= runs; run++) {
    for (const image of images) {
      const imagePath = path.join(folder, image);
      const pixels = pngDimensions(imagePath);
      for (const [qIndex, question] of questions.entries()) {
        for (const model of models) {
          overrideModel = model;
          lastCall = null;
          let answer = null;
          let error = null;
          try {
            answer = await askAboutRegion(imagePath, [{ role: 'user', content: question }]);
          } catch (err) {
            error = `[${err.code}] ${err.message}`;
          }
          if (!lastCall && !error?.startsWith('[network]')) {
            throw new Error('fetch wrapper never ran — model override did not apply; aborting');
          }
          results.push({ run, image, pixels, qIndex, model, answer, error, ...lastCall });
          console.log(`run ${run} ${image} q${qIndex + 1} ${model}: ${lastCall?.status} ${lastCall?.promptTokens} prompt tokens, ${lastCall?.latencyMs}ms${error ? ' ' + error : ''}`);
          await sleep(SPACING_MS);
        }
      }
    }
  }
  fs.writeFileSync(outPath + '.json', JSON.stringify({ folder, models, questions, runs, results }, null, 2));

  const px = (p) => (p ? `${p.width}x${p.height}` : '?');
  const lines = [
    '# Vision model comparison',
    '',
    `Run ${new Date().toISOString()} · ${runs} run(s) · folder \`${folder}\` · models ${models.map((m) => `\`${m}\``).join(', ')}`,
    '',
    'Unscored. Contains screen content — do not commit.',
    '',
    '## Questions',
    ...questions.map((q, i) => `${i + 1}. ${q}`),
    '',
    '## Metrics',
    '',
    '| run | image | pixels | q | model | status | prompt_tokens | completion_tokens | latency ms | rate-limit headers |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.run} | ${cell(r.image)} | ${px(r.pixels)} | ${r.qIndex + 1} | ${r.model} | ${r.status ?? '-'} | ${r.promptTokens ?? '-'} | ${r.completionTokens ?? '-'} | ${r.latencyMs ?? '-'} | ${cell(JSON.stringify(r.rateLimit ?? {}))} |`),
    '',
    '## Answers',
  ];
  for (const image of images) {
    const first = results.find((r) => r.image === image);
    lines.push('', `### ${image} (${px(first?.pixels)})`);
    for (const [qIndex, question] of questions.entries()) {
      lines.push('', `**Q${qIndex + 1}: ${question}**`, '', `| run | ${models.join(' | ')} |`, `|---|${models.map(() => '---').join('|')}|`);
      for (let run = 1; run <= runs; run++) {
        const row = models.map((m) => {
          const r = results.find((x) => x.run === run && x.image === image && x.qIndex === qIndex && x.model === m);
          return cell(r?.error ? `**ERROR** ${r.error}` : r?.answer);
        });
        lines.push(`| ${run} | ${row.join(' | ')} |`);
      }
    }
  }
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
