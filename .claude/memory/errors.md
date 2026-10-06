# errors.md — error and fix log

The ONLY place errors, bugs, and their fixes are logged. Do not log them in
decisions.md, project_state.md, phase_log.md, or todo.md. Those files may hold
a one-line pointer ("see errors.md E-012") and nothing more.

Existing rows in decisions.md that already describe past bugs stay where they
are (that file's rule: never delete rows). New errors go here.

## Rules
- Log an error when it is OBSERVED, not when it is fixed. Status starts `open`.
- `Cause` has two levels. Write `unconfirmed:` until real evidence (log line,
  repro, diff) backs it. Never write "reasoned through" as if it were verified.
- `Evidence` = the log line, command output, or commit that backs the claim.
- Newest entries on top. IDs never reused.
- Status: `open` | `fixed` | `mitigated` | `watching` | `wontfix`.

## Entry template
### E-NNN — short title
- Status:
- First seen: YYYY-MM-DD, phase/branch
- Symptom: what the user saw, exact text where there is one
- Cause: (unconfirmed: ...) or confirmed + evidence
- Fix: commit hash + one line, or `none yet`
- Avoid: how not to hit it again / what check would have caught it
- Evidence:

---

### E-001 — "Too many requests, try again in a moment." on every vision call
- Status: mitigated (the app now reports it honestly; no vision call to `mistral-small` can succeed until the limit or MODEL_ID changes)
- First seen: 2026-10-05, phase-2.3 (e4ce0ab). Noticed after a whole-screen capture, but image size turned out to be irrelevant.
- Symptom: Chat Panel shows "Too many requests, try again in a moment." with a Retry link. Clicking it shows "Retrying…" and the same error comes back.
- Cause: confirmed: the per-minute request limit is 0 for mistral-small-latest on this key. Mistral returns HTTP 429 with `x-ratelimit-limit-req-minute: 0`, no `retry-after`, body `{"message":"Rate limit exceeded","type":"rate_limited","code":"1300"}`. The pinned id `mistral-small-2603` behaves identically, so this isn't an alias issue.
  unconfirmed: WHY the limit is 0. The Mistral console ("Completion rate limits per model") shows `mistral-small-2603` at 20,000 tokens/min and 1.00 req/s, which disagrees with the API's 0 req/min (the API sends no tokens/min header for it at all). The console usage page counts only the one 200 to `ministral-3b-latest`, not the 429s.
  Ruled out by the repro:
  - Image tokens: a text-only "Say ok." also 429s, and so does a 936x806 crop.
  - Burst / per-second window: the first request in a fresh process 429s, as do requests after 60s idle and at 3s spacing.
  - Workspace-wide block: the `ministral-*` models return 200 on the same key.
  - Instant Retry is real (main.js `onRetry`), but it's not the cause. Waiting can't help when the limit is 0.
- Fix: 95760e4: a 429 with any `x-ratelimit-limit-*` of "0" now throws `quota_zero`. The panel says "This model has no quota on your Mistral plan. Check your Mistral console limits." with no Retry link. Other 429s stay `rate_limit`. This is a mitigation, not a fix: the underlying choice (account-side, or a MODEL_ID change that supersedes decisions.md row 1) is pending.
- Avoid: never map a status code straight to "try again" without checking whether the failure is transient. d51ac58 logs status, body and all headers on every non-2xx, so a zero limit shows up in the log.
- Evidence:
  - d51ac58, `node diagnostics/repro_rate_limit.js <full.png> <crop.png>`, 2026-10-06T02:41Z (headers trimmed to the rate-limit ones):
    ```
    [vision-diag] request: {"imageBytes":1082993,"imagePixels":{"width":2992,"height":1934},"requestBodyBytes":1444199,"turns":1,"msSinceLastRequest":null}
    [vision-diag] non-2xx response: {"status":429,"body":"{...\"message\":\"Rate limit exceeded\",\"type\":\"rate_limited\",...\"code\":\"1300\"...}", ... "x-ratelimit-limit-req-minute":"0","x-ratelimit-remaining-req-minute":"0"}
    [vision-diag] request: {..."msSinceLastRequest":1257}             -> 429, same headers
    [vision-diag] request: {"imageBytes":65114,"imagePixels":{"width":936,"height":806},...,"msSinceLastRequest":60447} -> 429, same headers
    ```
  - Ad hoc `node -e` calls (not in the repo), 2026-10-06T02:43Z and 02:56Z:
    ```
    TEXT-ONLY mistral-small-latest: 429 {"x-ratelimit-limit-req-minute":"0","x-ratelimit-remaining-req-minute":"0"}
    TEXT-ONLY ministral-3b-latest:  200 {"x-ratelimit-limit-req-minute":"750","x-ratelimit-limit-tokens-minute":"1300000",...}
    TEXT-ONLY mistral-small-2603:   429 {"x-ratelimit-limit-req-minute":"0","x-ratelimit-remaining-req-minute":"0"}   (pinned; then alias 190ms later: same)
    TEXT-ONLY mistral-small-latest: 429 limit 0, then mistral-small-2603 3s later: 429 limit 0   (reversed order, spaced)
    GET /v1/models: 200, mistral-small-latest -> mistral-small-2603, capabilities.vision true
    ```
  - `node diagnostics/model_quota_sweep.js <crop.png>`, 2026-10-06T02:56Z, 28 ids. limit-req-minute / limit-tokens-minute from the text-only call; image = the 936x806 crop:
    - all `mistral-small-*` ids (2603, latest, magistral-small-latest, mistral-vibe-cli-fast): 429 (1300), 0 / -
    - all 8 `mistral-medium-*` ids (incl. magistral-medium-latest, mistral-vibe-cli-latest/-with-tools): 429 (1300), 0 / -
    - ministral-3b-2512 / -latest: 200, 750 / 1,300,000; image 200, 1027 prompt tokens
    - ministral-8b-2512 / -latest: 200, 188 / 625,000; image 200, 1027 prompt tokens
    - ministral-14b-2512 / -latest: 200, 30 / 937,500; image 200, 1027 prompt tokens
    - mistral-ocr-* (7 ids): 400 (1500), no headers. Likely not chat-completions models (unconfirmed).
    - labs-leanstral-1-5 / -1-5-1: 403 (1913), no headers (unexplained)
  - 95760e4: repro script now prints `FAILED [quota_zero] This API key has no quota for model mistral-small-latest.` on all three attempts. Mocked 429s with limit 60 or no headers still give `rate_limit` + retryable. The real chatPanel.html, loaded in a throwaway Electron window, rendered the quota message with zero `.retry-link` elements.
  - Not run: the in-app repro through a real hotkey gesture (needs the user's hands).
  - `mistral-large-2512` (shown in the user's console) is absent from GET /v1/models: no id, name or alias contains "large" among the 46 ids. But GET /v1/models/mistral-large-2512 returns 200 (capabilities.vision true), and a text-only chat call returns `403 {"type":"tier_not_allowed","code":"1910","message":"This model is not available in your subscription tier"}`, with no rate-limit headers (ad hoc, 2026-10-06T03:05Z). So the API's explicit tier gate is a 403/1910. Why small/medium instead get a 429/1300 with limit 0 remains unexplained.
  - `node diagnostics/compare_vision_models.js <captures> <scratch.md>`, 2026-10-06T03:05Z, via the real askAboutRegion() with a fetch-level model override: all 24 calls returned 200. Prompt tokens were identical across ministral-14b/8b/3b: a 2992x1934 whole-screen PNG costs 2025 (Q1) / 2028 (Q2) tokens; the 1208x582 and 936x806 crops cost 954 / 1024. Answer quality has not been judged yet (by the user).

---

## Seed entries (from earlier phases)
Checked 2026-10-05 against decisions.md and each cited commit; corrections noted inline.

### E-002 — Hotkey-test callbacks never unregistered the candidate accelerator
- Status: fixed (498ba87)
- Cause: `startHotkeyTest()`/`rearmHotkeyTest()` callbacks lacked the `globalShortcut.unregisterAll()` that production's `registerHotkey()` callback makes, so the still-registered candidate claimed the trigger key's keyup and a real hold never finalized (hung until the watchdog).
- Avoid: any new path that activates the gesture overlay must copy the unregister step.

### E-003 — No logging on the hotkey-test path
- Status: fixed (e200421)
- Cause: the two test callbacks and the three IPC handlers (`hotkey-test-start`/`-cancel`, `hotkey-save`) logged nothing. This cost time diagnosing an accidental overlay activation; the logging added afterwards is what made the Command+3 finding (E-004) confirmable.
- Avoid: log first thing in every new callback or IPC handler.

### E-004 — Command/Meta chords fail on release
- Status: mitigated (878aa34, static block in the Settings recorder)
- Evidence: Command+3 and Command+7 both fired on press and lost the release, each on a hold past the ~445ms blind window (5000ms watchdog branch). Shift+3 passed as a control on the same code path. n=2, so weaker than the Option case.
- Revisit trigger: if any Command combo ever passes the live test, take the block off.

### E-005 — Option/Alt chords fail
- Status: mitigated (static block in the Settings recorder, added in ceb64e2). n=5 combos, mechanism understood: the macOS text-input/composition layer intercepts Option and swallows the trigger key's events (see decisions.md's hold/release section).

### E-006 — Hold-to-talk hardcoded `'Digit1'`
- Status: fixed (fb8e7e0). Broke silently once the hotkey was changed; `hold-to-talk-start` now carries `triggerKeyCode`.

### E-007 — Vietnamese dictation garbled on the `base` model
- Status: fixed (3270d2d). vi and es now use `small`. Before the upgrade, `-l vi`/`-l es` was confirmed to reach whisper-cli, and clip length was ruled out as the main driver.

### E-008 — `nodejs-whisper` `autoDownloadModel()` broken under Electron
- Status: mitigated (workaround only; found during 3270d2d). `shelljs.exec()` returns `undefined`; models are pre-downloaded by hand with `download-ggml-model.sh`.
- Open item: Phase 7 pre-packaging checklist (todo.md).

### E-009 — Dock icon disappears mid-session
- Status: watching. Seen twice (Phase 2.2, Phase 2.3). `[dock-diag]` logging is back in (f2a9186). Do not force a repro.

### E-010 — Dock icon absent on launch (Phase 2.2)
- Status: fixed (8bdc1f2). This Electron environment doesn't auto-promote to a Dock-visible app; `app.dock.show()` in `whenReady()`. Confirmed with the osascript "background only" check (true before, false after); why it doesn't auto-promote is unknown.

### E-011 — Uncommitted edit to phase_log.md
- Status: fixed (f2c913e, merged via PR #3). Process error: a correction to phase_log.md's Step 8 entry was made locally but never committed, so it missed PR #2.
