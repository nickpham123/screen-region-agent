const statusEl = document.getElementById('status');
const videoEl = document.getElementById('video');
const canvasEl = document.getElementById('canvas');
const runBtn = document.getElementById('run');

function setStatus(text) {
  statusEl.textContent = text;
}

function log(...args) {
  console.log(...args);
  window.verifyCapture.log(...args);
}

async function captureOneSource(sourceId) {
  const constraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
      },
    },
  };
  log('Requesting getUserMedia with constraints:', JSON.stringify(constraints));

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings();
  log('track.getSettings():', JSON.stringify(settings));

  videoEl.srcObject = stream;
  await new Promise(resolve => {
    videoEl.onloadedmetadata = resolve;
  });
  await videoEl.play();

  // Give the decoder a moment so we're drawing a real decoded frame, not an
  // empty first paint.
  await new Promise(resolve => setTimeout(resolve, 150));

  const videoWidth = videoEl.videoWidth;
  const videoHeight = videoEl.videoHeight;
  log(`video.videoWidth/videoHeight: ${videoWidth} x ${videoHeight}`);

  // Canvas sized ONLY from the video track's own reported size — never
  // recomputed from display.bounds independently (that's the "two
  // independently-computed sizes" bug shape from the Step 3 coordinate
  // mismatch, applied here to capture instead of the overlay trail).
  canvasEl.width = videoWidth;
  canvasEl.height = videoHeight;
  const ctx = canvasEl.getContext('2d');
  ctx.drawImage(videoEl, 0, 0, videoWidth, videoHeight);
  log(`canvas.width/height after draw: ${canvasEl.width} x ${canvasEl.height}`);

  track.stop();
  videoEl.srcObject = null;

  return {
    settingsWidth: settings.width,
    settingsHeight: settings.height,
    videoWidth,
    videoHeight,
  };
}

async function run() {
  setStatus('Fetching displays + sources...');
  const { displays, sources, error } = await window.verifyCapture.getDisplaysAndSources();

  if (error) {
    setStatus(`getSources() failed: ${error}`);
    return;
  }
  if (sources.length === 0) {
    setStatus(
      'No screen sources returned — check Screen Recording permission ' +
      '(System Settings > Privacy & Security > Screen Recording), then relaunch.'
    );
    return;
  }

  for (const display of displays) {
    setStatus(`Testing display ${display.id}...`);
    log('====================================');
    log(`Display ${display.id}: bounds=${JSON.stringify(display.bounds)} scaleFactor=${display.scaleFactor}`);

    const expectedWidth = display.bounds.width * display.scaleFactor;
    const expectedHeight = display.bounds.height * display.scaleFactor;
    log(`Expected physical size from bounds*scaleFactor: ${expectedWidth} x ${expectedHeight}`);

    const match = sources.find(s => s.display_id === String(display.id));
    if (!match) {
      log(
        `NO MATCHING SOURCE for display ${display.id} via display_id. Sources were:`,
        JSON.stringify(sources)
      );
      continue;
    }
    log(`Matched source: id=${match.id} name="${match.name}" display_id=${match.display_id}`);

    try {
      const result = await captureOneSource(match.id);
      const scaleFactorHolds =
        result.videoWidth === expectedWidth && result.videoHeight === expectedHeight;
      const settingsAgreeWithVideoEl =
        result.settingsWidth === result.videoWidth && result.settingsHeight === result.videoHeight;

      log(`RESULT display ${display.id}:`);
      log(
        `  scaleFactor formula holds: ${scaleFactorHolds} ` +
        `(expected ${expectedWidth}x${expectedHeight}, got ${result.videoWidth}x${result.videoHeight})`
      );
      log(`  getSettings() agrees with videoWidth/videoHeight: ${settingsAgreeWithVideoEl}`);
    } catch (err) {
      log(`Capture FAILED for display ${display.id}:`, err.message || err);
    }
  }

  log('====================================');
  setStatus('Done. Full results are in the terminal running `electron`.');
  window.verifyCapture.quit();
}

runBtn.addEventListener('click', run);

// Auto-run on load too, so this can be launched non-interactively (e.g. from
// a background process with nobody there to click the button) and will quit
// itself when done instead of sitting open.
run();
