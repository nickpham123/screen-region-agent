// One-off diagnostic (not app code): does nodejs-whisper actually work on
// this machine, on-device, with Metal? All three re-verified directly
// rather than assumed from docs, per the user's explicit ask when
// evaluating this as a replacement for whisper-node-addon.
//
// This triggers a REAL local build of whisper.cpp from source on first run
// (nodejs-whisper has no prebuilt binary — see dist/whisper.js) — expect it
// to take a few minutes. logger.log is NOT silenced here specifically so
// the CMake configure/build output — which is what actually answers the
// Metal question — is visible, unlike nodejs-whisper's own default (most
// output goes through logger.debug, silent unless you pass a verbose
// logger).
//
// Needs a real speech WAV at /tmp/whisper_test.wav first — generate one
// with (macOS):
//   say -o /tmp/whisper_test.aiff "Testing the region agent voice input."
//   afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/whisper_test.aiff /tmp/whisper_test.wav
//
// Run: node diagnostics/verify_nodejswhisper.js

const { nodewhisper } = require('nodejs-whisper');

const verboseLogger = {
  log: (...args) => console.log('[log]', ...args),
  debug: (...args) => console.log('[debug]', ...args),
  error: (...args) => console.log('[error]', ...args),
};

async function main() {
  const start = Date.now();
  try {
    const transcript = await nodewhisper('/tmp/whisper_test.wav', {
      modelName: 'base.en',
      autoDownloadModelName: 'base.en',
      removeWavFileAfterTranscription: false,
      logger: verboseLogger,
      whisperOptions: {
        outputInText: false,
        language: 'en',
      },
    });
    console.log('\n=== TRANSCRIPT ===\n', transcript);
    console.log(`\nTotal time: ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.log('\n=== FAILED ===\n', err.message);
  }
}

main();
