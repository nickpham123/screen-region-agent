// Settings persistence (Phase 2.3, system_design_plan.md §3.8). Reads/writes
// a small JSON file in userData — deliberately not JSONL/SQLite like the
// conversation log, since this is a single mutable object, not an
// append-only record stream; a flat JSON file is the simplest thing that
// fits the shape.
//
// Created now, not before this step needed it (CLAUDE.md's simplicity-first
// rule) — main.js reads this at startup to initialize nativeTheme.themeSource
// and the hotkey accelerator before any window is created, and every
// Settings control writes through it on change.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

const DEFAULTS = {
  hotkeyAccelerator: 'Control+1',
  hotkeyTriggerKeyCode: 'Digit1',
  displayName: '',
  theme: 'system', // 'light' | 'dark' | 'system'
  dictationLanguage: 'en', // key into DICTATION_LANGUAGES below
};

// Pinned-language options for hold-to-talk dictation (2026-08-25, see
// decisions.md — explicit pins were chosen over an auto-detect toggle:
// auto-detect is measurably less reliable on short clips, which is the norm
// for a hold-to-talk gesture, and pinning doesn't cost anything extra to
// verify since testing multiple specific languages was already the plan
// either way).
//
// whisperLanguage maps to nodejs-whisper's whisperOptions.language, which
// this file confirmed (by reading WhisperHelper.js directly, not the
// package's top-level IOptions typing, which doesn't have a `language`
// field at all — see decisions.md) becomes whisper.cpp's `-l` flag,
// re-confirmed 2026-08-25 via whisper.cpp's own runtime log (`lang = vi`)
// during real hands-on testing, not just read from source. English keeps
// the current `.en`-only model (smaller, and whisper.cpp's `.en` models are
// English-only regardless of -l).
//
// Vietnamese/Spanish upgraded from `base` to `small` 2026-08-25, on real
// evidence, not a default upgrade: `base` produced genuinely garbled
// Vietnamese output (real words assembled wrong, not accent/spelling
// slips) across multiple real dictations, including one at ~5s — ruling out
// short-clip length as the driver before concluding it was model size (see
// decisions.md for the full two-check process and results). `small` is a
// real cost, not a free upgrade: ~466MB vs. `base`'s 141MB, and slower
// per-inference — accepted because `base`'s output wasn't merely
// imperfect, it was unusable.
const DICTATION_LANGUAGES = {
  en: { label: 'English', modelName: 'base.en', whisperLanguage: 'en' },
  vi: { label: 'Vietnamese', modelName: 'small', whisperLanguage: 'vi' },
  es: { label: 'Spanish', modelName: 'small', whisperLanguage: 'es' },
};

// Falls back to defaults on a missing file (first launch) or malformed JSON
// — a broken settings file shouldn't crash startup, same "degrade
// gracefully" posture the rest of this app already takes on failure.
function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (err) {
    return { ...DEFAULTS };
  }
}

function saveSettings(partial) {
  const next = { ...loadSettings(), ...partial };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}

module.exports = { loadSettings, saveSettings, DEFAULTS, DICTATION_LANGUAGES };
