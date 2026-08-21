# To-Do

Concrete next actions, not aspirational plans (those live in `implementation_plan.md`). Keep this short — if it grows past ~10 items, it's turning back into a plan document; prune or move stale items to phase_log.md's log section.

## Now — Electron scaffold (per system_design_plan.md's verification-step plan)

- [x] Step 1: Scaffold minimal Electron app (main process + one window) → verify: app launches, shows a blank window
- [x] Step 2: Add `globalShortcut` hotkey press listener + immediate focus-grab on the overlay window → verify: pressing the key while any app is focused brings up a (blank for now) overlay that has keyboard focus
- [x] Step 3: Add window-scoped keyup detection on the overlay + mouse drag-to-select while the key is held, plus a "ready to select" badge on activation → verified: badge shows on activation **and persists until genuine movement**; dragging draws a freeform trail; releasing the key (not the mouse) finalizes and logs bbox coordinates. **Badge implementation is covered by this checkbox — there is no separate open badge item.** Notes (refreshed 2026-08-21): the live bbox-preview rectangle was superseded by click-to-reset (see decisions.md) and is no longer rendered; hotkey is **`Control+1`** (was `Alt+Space`, which was broken — see decisions.md); releasing the trigger key inside the ~445ms pre-auto-repeat blind window still loses the gesture, now bounded to ~2.5s rather than 5s
- [ ] **Step 4 (NEXT — start here): Add `desktopCapturer` + crop logic** → verify: releasing the drag saves a cropped PNG of that exact region
      - Note: Step 3 is closed, reviewed and merged to `main` (`e9fa2ba`, plus `4ee443b` for the single-instance lock). Nothing from Step 3 is outstanding.
      - Note: this step triggers macOS's Screen Recording permission prompt — the first permission this app asks for. Worth handling the not-yet-granted case rather than assuming it succeeds.
      - Note: the overlay emits bbox coordinates in the *renderer's* coordinate space, which was measured to disagree with `getCursorScreenPoint()` by a few px (see decisions.md). Verify the crop lands where the user drew before trusting the mapping.
- [ ] Step 5: Add the Chat Panel — text field auto-focused, message history list (starts empty), same key held again (window-scoped) triggers `whisper-node-addon` recording → verify: typing + Enter adds a message to history; holding the key and speaking transcribes into the field with no network call made
      - Implementation note: reuse the `spaceHeld`-bootstrap pattern from Step 3 (see decisions.md) — a key already down when a window gains focus won't fire a local `keydown`, so bootstrap "held" state from the activation signal itself, not from waiting on `keydown`. Apply this proactively for the hold-to-talk gesture instead of rediscovering it through the same debugging cycle.
      - Implementation note (2026-08-21): whatever accelerator Step 3 settles on, the hold-to-talk key inherits the same constraint — **no Option in the chord**, or the text-input layer will eat its keyup exactly as it did for `Alt+Space`. Also note the bootstrap pattern above is a first-instant workaround, not the whole story: a held key does emit auto-repeat `keydown`s (~80ms apart) once focus lands, which is what the Step 3 liveness watchdog now runs on and is available for hold-to-talk too.
- [ ] Step 6: Port `askAboutRegion(imagePath, conversationHistory)` to JS → verify: a real screenshot + single-turn history returns a real Mistral answer; a second call with the growing history returns a coherent follow-up answer
      - Implementation note: use a stable `prompt_cache_key` per session (keep the prefix — system prompt + image + prior turns — byte-identical across calls, only append the new turn) and downscale the crop before encoding — both cut token cost without limiting conversation length (see system_design_plan.md §3.5)
      - Implementation note: send a downscaled full-screenshot thumbnail alongside the crop on every call, plus a `requestFullScreenshot()` tool the model can invoke for full-resolution context when the thumbnail isn't enough (hybrid approach, see system_design_plan.md §3.5)
- [ ] Step 7: Wire Chat Panel submit → Response Handler → Vision Model Client → append answer to history → verify: full loop works for at least 2 back-and-forth turns in one session
- [ ] Step 8: On panel close, write the full turn history via Local Logger → verify: closing the panel produces one JSONL/SQLite row with all turns nested under it (schema in data_pipeline.md §1-2)

## Cleanup

- [ ] Delete the superseded Python prototype files (`capture.py`, `hotkey_listener.py`, `overlay.py`, `popup.py`, `main.py`, `requirements.txt`) once Electron reaches equivalent functionality

## Next (after Phase 1 loop works end to end)

- [ ] Add 👍/👎 feedback capture to the Chat Panel, captured once per conversation on close
- [ ] Decide the Phase 3 format-conversion approach for multi-turn sessions (flatten to single-turn training rows vs. train for full multi-turn — see data_pipeline.md §8)

## Later / deferred — not blocking current work

- [ ] Marketing/dashboard website introducing the product, cluely.com-inspired — come back to this once Phase 1 has something worth showing off

## Open — Step 3 follow-ups (in priority order)

- [x] ~~Pick a 2-key, non-Option replacement accelerator.~~ **Done 2026-08-21 — `Control+1`**, after testing seven candidates hands-on. 11/11 activations, zero failures. See decisions.md for why each alternative was rejected and why registration success proves nothing.
- [ ] **Investigate "sometimes the hotkey needs a harder press"** — *probably already explained*: macOS requires the modifier down before the trigger key, so simultaneous presses often don't match. Confirm this fully accounts for it during normal use before closing.
- [x] ~~Investigate the auto-drawn zigzag on activation.~~ **Done 2026-08-21.** Root cause was not the suspected residual point (that hypothesis was measured and disproven) but mixing two coordinate sources — the main process's activation point vs the renderer's `clientX/clientY`, which disagree by a few px for the same stationary cursor. Fixed by anchoring the trail on the first mousemove. A follow-on 2px dot from zero-delta mousemoves was fixed with an exact-equality guard. Both verified against the three symptoms (still hold → no marks, real drag → correct bbox, badge persists until real movement). See decisions.md's consolidated hold/release section.
- [x] ~~Fix focus instability on activation.~~ **Closed 2026-08-21 — was a testing artifact, not a real defect.** The measurements behind it were taken with multiple Electron instances running at once (each `npm start` left the previous alive; every instance registered the same accelerator and fought over focus-steal). Measured cleanly on one instance: `isFocused` was `true` immediately on 34 of 35 gestures. See decisions.md §4 — kept as a section because the *methodology* lesson matters more than the non-finding.
- [ ] **Test whether `unregister()`-on-activate is still load-bearing.** Its supporting evidence was collected on the broken `Alt+Space` accelerator and is now explained by Option interception instead (see decisions.md). Remove it, run the gesture protocol, see if keyups still arrive.
- [ ] **Test whether `UNREGISTER_SETTLE_MS` can now be removed.** The original task that started all this. It was never justified — its stated rationale (fixing quick taps) is disproven — but removing it stayed unverifiable while nothing worked. There's finally a passing baseline to test against. Do this *after* the accelerator is settled, one variable at a time.
- [ ] **Decide accelerator configurability.** Three hardcoded accelerators in three iterations, each replaced for a reason the prior round's checks couldn't catch. Evidence now favours making it user-configurable over hunting for a better constant — see decisions.md.

**Closed 2026-08-21**: the `uiohook-napi` question. Its revisit trigger ("deliberate holds start losing keyups") appeared to fire, but the cause was the accelerator, not `globalShortcut`. Deliberate holds work. Stays deferred on its original terms.

## Open — robustness, not blocking Step 3

- [ ] **Investigate silent process death.** During Step 3 debugging (2026-08-20), the Electron app exited entirely mid-session — confirmed via `ps aux` showing no process, with nothing in the log explaining why (no crash trace, no uncaught-exception output; the log just stops). Happened around a stuck/unresolved gesture, but the causal link is unconfirmed — the timing may be coincidental. Not resolved by the stuck-gesture safety net, which addresses a stranded hotkey, not a dead process. Worth its own investigation once the hotkey/keyup thread is closed.

## Open questions blocking later phases

- [ ] Whether `image_context` (full screenshot) is always sent alongside the crop, or only conditionally — now relevant per-turn, not just once per session
- [ ] Which whisper.cpp model size to bundle (base.en vs small.en — accuracy/size/speed tradeoff) and how the model file gets distributed with the packaged app