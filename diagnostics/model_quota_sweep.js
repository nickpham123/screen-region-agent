// Model quota sweep for errors.md E-001 — which Mistral models does this
// API key actually have request quota for, according to the API itself
// (not the console)? Evidence for the MODEL_ID decision, not a fix.
//
// For every model id GET /v1/models lists as vision-capable, plus any
// mistral-small-* id regardless of capability: one text-only "Say ok."
// request, recording status and the x-ratelimit-limit-* headers. Every id
// that returns 200 then gets one small image request, to confirm it
// genuinely accepts images. Aliases are tested as separate ids on purpose —
// whether an alias behaves like its pinned id is part of the question.
//
// Requests are spaced SPACING_MS apart so a low req/s limit can't produce
// a false 429. Never prints the API key.
//
// Requires MISTRAL_API_KEY in .env.
// Run: node diagnostics/model_quota_sweep.js <small-crop.png>

require('dotenv').config({ quiet: true });
const fs = require('fs');

const BASE = 'https://api.mistral.ai/v1';
const SPACING_MS = 1500;
const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chat(model, content) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages: [{ role: 'user', content }] }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return {
    status: res.status,
    reqMin: res.headers.get('x-ratelimit-limit-req-minute') ?? '-',
    tokMin: res.headers.get('x-ratelimit-limit-tokens-minute') ?? '-',
    promptTokens: json?.usage?.prompt_tokens ?? '-',
    errCode: res.ok ? '' : (json?.code ?? json?.type ?? text.slice(0, 40)),
  };
}

async function main() {
  const imagePath = process.argv[2];
  if (!process.env.MISTRAL_API_KEY || !imagePath || !fs.existsSync(imagePath)) {
    console.error('Usage: node diagnostics/model_quota_sweep.js <small-crop.png>  (MISTRAL_API_KEY in .env)');
    process.exit(1);
  }
  const imageUrl = `data:image/png;base64,${fs.readFileSync(imagePath).toString('base64')}`;

  const res = await fetch(`${BASE}/models`, { headers });
  const models = (await res.json()).data
    .filter((m) => m.capabilities?.vision || /^mistral-small/.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  console.log(`${new Date().toISOString()} — ${models.length} model id(s) to test, image: ${imagePath}\n`);

  const rows = [];
  for (const m of models) {
    const t = await chat(m.id, 'Say ok.');
    await sleep(SPACING_MS);
    let img = { status: '-', promptTokens: '-' };
    if (t.status === 200 && m.capabilities?.vision) {
      img = await chat(m.id, [
        { type: 'image_url', image_url: imageUrl },
        { type: 'text', text: 'What does this image show? One sentence.' },
      ]);
      await sleep(SPACING_MS);
    }
    rows.push({
      'model id': m.id,
      'resolves to': m.name,
      vision: m.capabilities?.vision ? 'y' : 'n',
      'text status': t.status + (t.errCode ? ` (${t.errCode})` : ''),
      'limit-req-minute': t.reqMin,
      'limit-tokens-minute': t.tokMin,
      'image status': img.status,
      'image prompt_tokens': img.promptTokens,
    });
  }
  console.table(rows);
}

main();
