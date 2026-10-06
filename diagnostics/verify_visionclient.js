// Standalone verification for visionClient.js's askAboutRegion() (Step 6).
// Hits the real Mistral API against a real crop already on disk from a
// prior Chat Panel session — not Electron-dependent, so run directly with
// node rather than launching the app. Confirms, per todo.md's Step 6 verify
// criteria:
//   1. a single-turn call (one real screenshot + one question) returns a
//      real, non-empty Mistral answer.
//   2. a follow-up call with the growing history returns a coherent answer
//      that's consistent with the first turn (not just "any text").
// Requires MISTRAL_API_KEY to be set in the environment.
// Run: node diagnostics/verify_visionclient.js <path-to-a-real-crop.png>

const fs = require('fs');
const { askAboutRegion } = require('../src/shared/visionClient');

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK:', msg);
}

async function main() {
  const imagePath = process.argv[2];
  if (!imagePath || !fs.existsSync(imagePath)) {
    console.error('Usage: node diagnostics/verify_visionclient.js <path-to-a-real-crop.png>');
    console.error('Pass a real crop.png from userData/captures/ (see project_state.md).');
    process.exit(1);
  }

  console.log('Using image:', imagePath);

  // Case 1: single-turn.
  const history = [{ role: 'user', content: 'What does this image show? Answer in one sentence.' }];
  const firstAnswer = await askAboutRegion(imagePath, history);
  assert(typeof firstAnswer === 'string' && firstAnswer.trim().length > 0, 'single-turn call returned a non-empty answer');
  console.log('First answer:', firstAnswer);

  // Case 2: follow-up, growing the same history — this is the real test of
  // multi-turn wiring, not just a second independent call.
  history.push({ role: 'assistant', content: firstAnswer });
  history.push({ role: 'user', content: 'Can you repeat back, in a few words, what you just said?' });
  const secondAnswer = await askAboutRegion(imagePath, history);
  assert(typeof secondAnswer === 'string' && secondAnswer.trim().length > 0, 'follow-up call returned a non-empty answer');
  console.log('Second answer:', secondAnswer);

  // Case 3: a missing API key surfaces the expected clear error, not a
  // confusing downstream failure.
  const realKey = process.env.MISTRAL_API_KEY;
  delete process.env.MISTRAL_API_KEY;
  let threwMissingKey = false;
  try {
    await askAboutRegion(imagePath, history);
  } catch (err) {
    threwMissingKey = /MISTRAL_API_KEY/.test(err.message);
  } finally {
    process.env.MISTRAL_API_KEY = realKey;
  }
  assert(threwMissingKey, 'missing API key throws a clear, specific error');

  console.log('\nAll visionClient checks passed. Read the two real answers above and confirm by eye:');
  console.log('  - the first answer actually describes the image content');
  console.log('  - the second answer reads as a coherent follow-up (proves history round-tripped), not a fresh unrelated answer');
}

main().catch((err) => {
  console.error('FAIL:', err.code ? `[${err.code}] ` : '', err.message);
  process.exit(1);
});
