// Reproduction for errors.md E-001 ("Too many requests, try again in a
// moment." after a whole-screen capture). Drives the real
// askAboutRegion() against the real Mistral API — the same function the
// Chat Panel calls — so visionClient.js's [vision-diag] lines show exactly
// what Mistral returned. Not Electron-dependent (same as
// verify_visionclient.js), so this needs no hands-on gesture; it stands in
// for the in-app repro, it doesn't replace it.
//
// Sequence, mirroring the reported symptom:
//   A. a whole-screen-sized image, one turn          (the first send)
//   B. the identical request again, immediately      (what Retry does today)
//   C. after a 60s wait, a small region crop         (does a small one pass?)
//
// Requires MISTRAL_API_KEY in .env.
// Run: node diagnostics/repro_rate_limit.js <whole-screen.png> <small-crop.png>

const fs = require('fs');
const { askAboutRegion } = require('../src/shared/visionClient');

const WAIT_MS = 60_000;

async function attempt(label, imagePath) {
  console.log(`\n=== ${label}: ${imagePath}`);
  const history = [{ role: 'user', content: 'What does this image show? Answer in one sentence.' }];
  try {
    const answer = await askAboutRegion(imagePath, history);
    console.log(`=== ${label}: OK —`, JSON.stringify(answer));
  } catch (err) {
    console.log(`=== ${label}: FAILED [${err.code}] ${err.message}`);
  }
}

async function main() {
  const [bigPath, smallPath] = process.argv.slice(2);
  if (!bigPath || !smallPath || !fs.existsSync(bigPath) || !fs.existsSync(smallPath)) {
    console.error('Usage: node diagnostics/repro_rate_limit.js <whole-screen.png> <small-crop.png>');
    process.exit(1);
  }
  await attempt('A (whole screen)', bigPath);
  await attempt('B (immediate re-send, like Retry)', bigPath);
  console.log(`\n... waiting ${WAIT_MS / 1000}s ...`);
  await new Promise((r) => setTimeout(r, WAIT_MS));
  await attempt('C (small crop after 60s)', smallPath);
}

main();
