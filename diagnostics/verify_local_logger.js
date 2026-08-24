// Standalone Step 8 verification — localLogger.js's logConversation() and
// main.js's trimToCompleteExchanges() dangling-turn logic. Needs a real
// Electron process (logConversation() calls app.getPath('userData')),
// but doesn't touch any window — same "no UI needed" shape as
// verify_capture_main.js.
//
// Run with:
//   npx electron diagnostics/verify_local_logger.js
//
// What it checks, logged, never assumed:
//   1. logConversation() appends one well-formed JSONL line matching
//      system_design_plan.md §5's schema (id/image_crop/image_context/
//      app_hint/turns/category/feedback/source/started_at/ended_at).
//   2. trimToCompleteExchanges() — duplicated here rather than imported,
//      same precedent as diagnostics/verify_move_file.js duplicating
//      moveFile() (main.js requires 'electron' at module scope, this
//      still needs to exercise the exact logic though, not just eyeball
//      it) — trims a trailing unanswered 'user' turn, leaves a
//      well-formed (ends-on-assistant) array untouched, and handles an
//      all-unanswered / empty array down to zero.

const { app } = require('electron');
const fs = require('fs');
const { logConversation, LOG_PATH } = require('../localLogger');

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('PASS:', msg);
}

// Exact duplicate of main.js's helper — see comment above for why.
function trimToCompleteExchanges(turns) {
  if (turns.length > 0 && turns[turns.length - 1].role === 'user') {
    return turns.slice(0, -1);
  }
  return turns;
}

app.whenReady().then(() => {
  // --- Part 1: trimToCompleteExchanges() ---
  const complete = [
    { role: 'user', content: 'what is this' },
    { role: 'assistant', content: 'a chart' },
  ];
  assert(
    trimToCompleteExchanges(complete) === complete,
    'well-formed (ends on assistant) turns returned untouched'
  );

  const dangling = [
    { role: 'user', content: 'what is this' },
    { role: 'assistant', content: 'a chart' },
    { role: 'user', content: 'what does the x-axis mean' }, // cancelled/never answered
  ];
  const trimmed = trimToCompleteExchanges(dangling);
  assert(trimmed.length === 2, 'dangling trailing user turn trimmed off (3 -> 2)');
  assert(trimmed[1].role === 'assistant', 'trimmed array still ends on the real assistant reply');

  const onlyDangling = [{ role: 'user', content: 'what is this' }];
  assert(
    trimToCompleteExchanges(onlyDangling).length === 0,
    'a session with only one unanswered question trims down to zero'
  );

  assert(trimToCompleteExchanges([]).length === 0, 'empty turns stays empty');

  // --- Part 2: logConversation() writes the real schema ---
  const before = fs.existsSync(LOG_PATH)
    ? fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean).length
    : 0;

  const startedAt = new Date(Date.now() - 5000).toISOString();
  const endedAt = new Date().toISOString();
  logConversation({
    cropPath: '/fake/permanent/crop-test.png',
    contextPath: '/fake/permanent/full-test.png',
    turns: complete,
    startedAt,
    endedAt,
  });

  const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
  assert(lines.length === before + 1, 'exactly one new line appended (JSONL, not overwritten)');

  const record = JSON.parse(lines[lines.length - 1]);
  console.log('Logged record:', JSON.stringify(record, null, 2));

  assert(typeof record.id === 'string' && record.id.length > 0, 'id is a non-empty uuid string');
  assert(record.image_crop === '/fake/permanent/crop-test.png', 'image_crop is the permanent path passed in');
  assert(record.image_context === '/fake/permanent/full-test.png', 'image_context is the permanent path passed in');
  assert(record.app_hint === null, 'app_hint defaults to null (no detection built yet)');
  assert(JSON.stringify(record.turns) === JSON.stringify(complete), 'turns round-trips exactly, nested');
  assert(record.category === null, 'category defaults to null (assigned during Phase 3 curation)');
  assert(record.feedback === null, 'feedback defaults to null (no capture UI built yet)');
  assert(record.source === 'real_usage', "source defaults to 'real_usage'");
  assert(record.started_at === startedAt, 'started_at matches what was passed in');
  assert(record.ended_at === endedAt, 'ended_at matches what was passed in');

  console.log('\nAll checks passed. Log file:', LOG_PATH);
  app.quit();
}).catch((err) => {
  console.error('DIAGNOSTIC FAILED:', err);
  app.exit(1);
});
