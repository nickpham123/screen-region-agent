// Counts-only scoring of transcription answers from compare_vision_models.js
// (errors.md E-001's model decision). Scores ONLY spots whose true text
// exists in the repo: three lines of src/chatPanel/chatPanel.html as of
// fb8e7e0, which were on screen (as a Claude Code diff view) in two of the
// local captures. The key is read from git, not retyped here.
//
// What is VISIBLE differs from the key — that is the point. Checked by eye
// against zoomed crops of the two images (2026-10-06):
//   line 499  `if (e.code !== triggerKeyCode || !holding) return;`
//             full screenshot: fully visible. Crop: outside the crop.
//   line 502  `// this listener ever sees for a given hold is already a repeat (the`
//             full screenshot: fully visible, nothing after "(the".
//             crop: cut by the crop's right edge after "(" + half a "t".
//   line 508  identical text to 499, but in BOTH images only "if (" is
//             visible — the app's own window covers the rest. Writing the
//             full line is text beyond what the screen shows, even though
//             it matches the repo (a model can copy it from line 499).
//
// Categories per (answer, spot):
//   exact     — matches what is visible, stops where the screen stops
//   cut-off   — stops at/before the visible edge and marks it
//               ([unreadable], …, ...)
//   invented  — text beyond what the screen shows
//   wrong     — the visible part is mis-transcribed
//   missing   — no line for that spot could be found in the answer
// Rule-based extraction; every result is printed with the extracted line so
// a human can audit it.
//
// Run: node diagnostics/score_transcriptions.js <results.json> <out.md>
// (results.json is written by compare_vision_models.js next to its .md.)
// The output quotes screen content — scratch or gitignored path only.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const KEY_COMMIT = 'fb8e7e0';
const keyLines = execFileSync('git', ['show', `${KEY_COMMIT}:src/chatPanel/chatPanel.html`], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf8',
}).split('\n');
const KEY = { 499: keyLines[498].trim(), 502: keyLines[501].trim(), 508: keyLines[507].trim() };
if (KEY[499] !== KEY[508]) throw new Error('key changed: lines 499 and 508 are expected to be identical');

// Which spots each capture shows, and how (see header).
const IMAGES = {
  'screen-region-full-1787686991299.png': { 499: 'full', 502: 'full', 508: 'occluded' },
  'screen-region-crop-1787686991299.png': { 502: 'cut', 508: 'occluded' },
};
const SPOTS = [499, 502, 508];

// "?" counts as a marker only at the very end (e.g. "(?" for the half-
// visible "t" on line 502) — an honest "can't read this", not a guess.
const MARKER = /\[unreadable\]|\[cut off\]|\[truncated\]|…|\.\.\.|\?(?=\s*$)/gi;
const LINE_502_CORE = 'this listener ever sees for a given hold is already a repeat';
if (KEY[502] !== `// ${LINE_502_CORE} (the`) throw new Error('key changed: line 502 no longer matches');

// Splits one answer line into { label, marker, text }: the diff view's
// 3-digit line number (also "Line 509:"), its +/- marker, and the code
// itself with quotes/whitespace normalized. Box-drawing and backtick
// wrappers that models add are dropped.
function parseLine(raw) {
  let s = raw.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/^[\s│|>]+/, '');
  s = s.replace(/^line\s+(?=\d{3})/i, '');
  const num = s.match(/^(\d{3})\b[:.]?\s*/);
  const label = num ? num[1] : null;
  if (num) s = s.slice(num[0].length);
  s = s.replace(/^`+/, '');
  let marker = null;
  const dm = s.match(/^([+-])\s*(?=if\b|\/\/|window|hold|reco)/);
  if (dm) { marker = dm[1]; s = s.slice(dm[0].length); }
  const text = s.replace(/`+\s*$/, '').replace(/\s+/g, ' ').trim();
  return { label, marker, text, fence: raw.trim().startsWith('```') };
}
const hasMarker = (s) => { MARKER.lastIndex = 0; return MARKER.test(s); };
const stripMarkers = (s) => s.replace(MARKER, '').trim();
const isHeader = (l) => /Update ?\(|Added \d+ lines?/i.test(l.text);

function score(answer, spec) {
  const lines = (answer || '').split('\n').map(parseLine).filter((l) => l.text || l.fence);
  const out = {};
  const i502 = lines.findIndex((l) => /already a repeat|this listener ever sees/i.test(l.text));

  if (spec[502]) {
    if (i502 === -1) out[502] = { cat: 'missing', text: '' };
    else {
      const c = lines[i502].text;
      // Nothing follows line 502 on screen in either image (the next thing
      // is the "Update(...)" header), so a further comment line straight
      // after it — the repo's real line 503 or anything else — is invented.
      // Two exceptions seen in real answers: re-emitting line 500/501's
      // text (on screen, just misordered) and a note about visibility
      // ("// The rest of the code is not fully visible") — neither is
      // invented screen text.
      const next = lines[i502 + 1];
      const onScreen = /gated on e\.repeat|re-arms the main-process watchdog|every key ?down/i;
      const visibilityNote = /not (fully )?visible|cut off|rest of the code|unreadable|truncated/i;
      const continues = next && !next.fence && next.text.startsWith('//')
        && !onScreen.test(next.text) && !visibilityNote.test(next.text);
      const text = continues ? `${c} ⏎ ${next.text}` : c;
      let cat;
      if (!c.toLowerCase().includes(LINE_502_CORE)) cat = 'wrong';
      else {
        const tail = c.slice(c.toLowerCase().indexOf(LINE_502_CORE) + LINE_502_CORE.length).trim();
        const clean = stripMarkers(tail).replace(/["'`]+$/, '').trim();
        if (spec[502] === 'full') {
          if (continues || (clean.startsWith('(the') && clean.length > 4)) cat = 'invented';
          else if (clean === '(the') cat = 'exact';
          else cat = 'wrong';
        } else {
          // cut after "(" + half a "t"
          if (continues || (clean.startsWith('(') && clean.length > 2)) cat = 'invented';
          else if (clean === '(' || clean === '(t') cat = hasMarker(tail) ? 'cut-off' : 'exact';
          else if (clean === '' && hasMarker(tail)) cat = 'cut-off';
          else cat = 'wrong';
        }
      }
      out[502] = { cat, text };
    }
  }

  // Line 499 sits above 502 on screen, as the "+" half of a -/+ pair.
  if (spec[499]) {
    const above = (i502 === -1 ? lines : lines.slice(0, i502)).filter((l) => /holding/.test(l.text));
    const c = above.find((l) => l.marker === '+')
      || (above.length >= 2 ? above[above.length - 1] : null)
      || (above.length === 1 && !/Digit1/.test(above[0].text) ? above[0] : null);
    if (!c) out[499] = { cat: 'missing', text: '' };
    else out[499] = { cat: c.text.includes(KEY[499]) ? 'exact' : 'wrong', text: c.text };
  }

  // Line 508, located in order of preference: (1) lines the model labelled
  // 508; (2) `if` lines after the first "Update(...)" header that follows
  // 502, up to the next transcript bullet; (3) `if` lines right after 502
  // in the same code block — where 505-511 sit on screen, for answers that
  // moved the header elsewhere.
  if (spec[508]) {
    let cands = lines.filter((l) => l.label === '508');
    if (!cands.length && i502 !== -1) {
      const h = lines.findIndex((l, i) => i > i502 && isHeader(l));
      if (h !== -1) {
        for (const l of lines.slice(h + 1)) {
          if (/Let me check|Searched for/i.test(l.text)) break;
          if (/^if\b/i.test(l.text)) cands.push(l);
        }
      }
      if (!cands.length) {
        for (const l of lines.slice(i502 + 1)) {
          if (l.fence || isHeader(l)) break;
          if (/^if\b/i.test(l.text)) cands.push(l);
        }
      }
    }
    if (!cands.length) out[508] = { cat: 'missing', text: '' };
    else {
      const cats = cands.map((l) => {
        const rest = stripMarkers(l.text.replace(/^if\s*\(?/i, ''));
        if (rest === '') return hasMarker(l.text) ? 'cut-off' : 'exact';
        // The app window's "Captures" sidebar label is on screen right
        // after "if (" on this row: reading across both windows is a
        // mis-transcription, not invented text.
        if (/^Captures\b/.test(rest)) return 'wrong';
        return 'invented';
      });
      const cat = ['invented', 'wrong', 'cut-off', 'exact'].find((k) => cats.includes(k));
      const matchesKey = cands.some((l) => l.text.includes(KEY[508]));
      out[508] = { cat, text: cands.map((l) => l.text).join(' ⏎ '), matchesKey };
    }
  }
  return out;
}

function main() {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) {
    console.error('Usage: node diagnostics/score_transcriptions.js <results.json> <out.md>');
    process.exit(1);
  }
  const { models, questions, runs, results } = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const scoredQ = questions.map((q, i) => i).filter((i) => /transcribe/i.test(questions[i]));

  const rows = []; // { model, run, image, q, spot, cat, text, matchesKey }
  for (const r of results) {
    const spec = IMAGES[r.image];
    if (!spec || !scoredQ.includes(r.qIndex)) continue;
    const s = r.error ? null : score(r.answer, spec);
    for (const spot of SPOTS) {
      if (!spec[spot]) continue;
      const res = s ? s[spot] : { cat: 'error', text: r.error };
      rows.push({ model: r.model, run: r.run, image: r.image, q: r.qIndex + 1, spot, ...res });
    }
  }

  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|');
  const counts = (rs) => {
    const c = {};
    for (const r of rs) c[r.cat] = (c[r.cat] || 0) + 1;
    return Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ');
  };
  const modeShare = (vals) => {
    const c = {};
    for (const v of vals) c[v] = (c[v] || 0) + 1;
    return Math.max(...Object.values(c));
  };

  const lines = [
    '# Transcription scoring (counts only)',
    '',
    `Key: \`git show ${KEY_COMMIT}:src/chatPanel/chatPanel.html\` lines 499 / 502 / 508. Scored questions: ${scoredQ.map((i) => `Q${i + 1}`).join(', ')}. ${runs} run(s). Contains screen content — do not commit.`,
    '',
    '## Per model × question × spot (counts over runs)',
    '',
    '| model | Q | image | spot | visible as | categories | same category | same extracted text |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const model of models) {
    for (const q of scoredQ.map((i) => i + 1)) {
      for (const image of Object.keys(IMAGES)) {
        for (const spot of SPOTS) {
          if (!IMAGES[image][spot]) continue;
          const rs = rows.filter((r) => r.model === model && r.q === q && r.image === image && r.spot === spot);
          if (!rs.length) continue;
          const short = image.includes('-full-') ? 'full' : 'crop';
          lines.push(`| ${model} | Q${q} | ${short} | ${spot} | ${IMAGES[image][spot]} | ${counts(rs)} | ${modeShare(rs.map((r) => r.cat))}/${rs.length} | ${modeShare(rs.map((r) => r.text))}/${rs.length} |`);
        }
      }
    }
  }

  lines.push('', '## Invented text: Q2 vs Q3 (the "[unreadable]" instruction)', '', '| model | question | invented / scored | of which matches repo key (line 508) |', '|---|---|---|---|');
  for (const model of models) {
    for (const q of scoredQ.map((i) => i + 1)) {
      const rs = rows.filter((r) => r.model === model && r.q === q && r.cat !== 'error');
      const inv = rs.filter((r) => r.cat === 'invented');
      lines.push(`| ${model} | Q${q} | ${inv.length} / ${rs.length} | ${inv.filter((r) => r.matchesKey).length} |`);
    }
  }

  lines.push('', '## Every classification (for audit)', '', '| model | run | image | Q | spot | category | extracted text |', '|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const short = r.image.includes('-full-') ? 'full' : 'crop';
    lines.push(`| ${r.model} | ${r.run} | ${short} | Q${r.q} | ${r.spot} | ${r.cat}${r.matchesKey ? ' (=key)' : ''} | \`${cell(r.text)}\` |`);
  }
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`Scored ${rows.length} (answer, spot) pairs → ${outPath}`);
}

main();
