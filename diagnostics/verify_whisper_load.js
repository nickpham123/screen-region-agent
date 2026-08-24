// One-off diagnostic (not app code): does whisper-node-addon's prebuilt
// native binary actually load and fail gracefully inside THIS project's
// real Electron process? Two separate questions, tested empirically rather
// than assumed from docs, which document neither:
//   1. Does it load at all, given it was built against Electron 31.7.7's
//      ABI while this project runs ^43.4.1? (N-API is designed to be
//      ABI-stable across versions — confirmed this holds here, not assumed.)
//   2. Does calling transcribe() with a missing model file reject the
//      Promise cleanly, or crash the whole process (a Promise wrapper
//      alone doesn't guarantee this — native code can still segfault
//      before ever reaching the JS reject callback)?
//
// Kept as the evidence artifact for the dlopen/rpath finding recorded in
// decisions.md, even though the project has since switched to
// nodejs-whisper — see that finding for why. whisper-node-addon was
// uninstalled once the switch was made, so `require()` below will fail
// with a plain module-not-found error unless you `npm install
// whisper-node-addon` again first; that failure is not itself a
// reproduction of the finding.
//
// Run: ./node_modules/.bin/electron diagnostics/verify_whisper_load.js

async function main() {
  let whisper;
  try {
    whisper = require('whisper-node-addon');
    console.log('LOAD OK — module resolved. Keys:', Object.keys(whisper));
  } catch (err) {
    console.log('LOAD FAILED —', err.name + ':', err.message);
    process.exit(0);
  }

  try {
    const result = await whisper.transcribe({
      model: '/tmp/definitely-does-not-exist-ggml-base.bin',
      fname_inp: '/tmp/definitely-does-not-exist-audio.wav',
      language: 'en',
    });
    console.log('TRANSCRIBE UNEXPECTEDLY SUCCEEDED:', result);
  } catch (err) {
    console.log('TRANSCRIBE REJECTED CLEANLY —', err.name + ':', err.message);
  }
  console.log('PROCESS SURVIVED TO THE END — no crash.');
  process.exit(0);
}

main();
