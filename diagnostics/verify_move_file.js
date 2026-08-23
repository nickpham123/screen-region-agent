// Standalone verification for main.js's moveFile() helper (Step 5 temp-file
// lifecycle). Not Electron-dependent — plain fs/path logic — so it's tested
// here directly rather than requiring a full app launch + gesture. Confirms:
//   1. the normal rename() path actually moves a file (content preserved,
//      source gone, destination correct).
//   2. the EXDEV fallback (copy+unlink) produces an identical result when
//      rename() is unavailable — simulated by monkey-patching fs.renameSync
//      to throw EXDEV, since forcing a real cross-device rename isn't
//      practical to set up on demand.
// Run: node diagnostics/verify_move_file.js

const fs = require('fs');
const path = require('path');
const os = require('os');

// Same function as main.js's moveFile() — duplicated here rather than
// imported because main.js requires 'electron' at the top of the file and
// can't be loaded outside an Electron process.
function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK:', msg);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-move-file-'));

// Case 1: normal rename.
{
  const src = path.join(dir, 'a-src.png');
  const dest = path.join(dir, 'a-dest.png');
  fs.writeFileSync(src, 'content-a');
  moveFile(src, dest);
  assert(!fs.existsSync(src), 'rename path: source no longer exists');
  assert(fs.existsSync(dest), 'rename path: destination exists');
  assert(fs.readFileSync(dest, 'utf8') === 'content-a', 'rename path: content preserved');
}

// Case 2: EXDEV fallback, forced by monkey-patching renameSync.
{
  const src = path.join(dir, 'b-src.png');
  const dest = path.join(dir, 'b-dest.png');
  fs.writeFileSync(src, 'content-b');

  const realRename = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('cross-device link not permitted');
    err.code = 'EXDEV';
    throw err;
  };
  try {
    moveFile(src, dest);
  } finally {
    fs.renameSync = realRename;
  }
  assert(!fs.existsSync(src), 'EXDEV fallback: source no longer exists');
  assert(fs.existsSync(dest), 'EXDEV fallback: destination exists');
  assert(fs.readFileSync(dest, 'utf8') === 'content-b', 'EXDEV fallback: content preserved');
}

// Case 3: a real (non-EXDEV) error still propagates rather than being
// silently swallowed by the fallback branch.
{
  const src = path.join(dir, 'does-not-exist.png');
  const dest = path.join(dir, 'c-dest.png');
  let threw = false;
  try {
    moveFile(src, dest);
  } catch (err) {
    threw = err.code === 'ENOENT';
  }
  assert(threw, 'non-EXDEV errors (e.g. ENOENT) propagate, not swallowed');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('\nAll moveFile() checks passed.');
