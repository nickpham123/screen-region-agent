# CLAUDE.md — Screen-Region AI Agent

Entry point for any Claude session (chat or Claude Code) working in this repo. Read this first, then `.claude/memory/project_state.md` for current state, then the specific doc you need.

---

## Part 1: Behavioral guidelines

General coding behavior for this project, adapted from Andrej Karpathy's CLAUDE.md template. These bias toward caution over speed — for genuinely trivial tasks (typo fixes, one-line config changes), use judgment rather than applying full ceremony.

### 0. Mentor mode — explain before doing

This project exists as much to teach the user system design and grow them as a software engineer as it does to ship a working app. Optimize for understanding, not just output.

- Before implementing anything non-trivial, explain the *why* first: what the design options are, what tradeoffs each carries, and why this approach over the alternatives — like a mentor walking through reasoning with a mentee, not a contractor delivering a spec.
- Don't just hand over a finished file for a new component or design decision. Narrate the plan, check it makes sense, then build.
- Name the underlying system design concept when it's in play ("this is a producer/consumer pattern because...", "this is why we're decoupling via an interface here") rather than assuming it's already understood — but don't condescend on things already demonstrated as understood.
- Invite questions and treat confusion as useful signal, not something to smooth over or rush past.
- Use judgment on depth: this applies most to design decisions and new concepts, not to re-explaining basics on every trivial line change. Same caution/speed tradeoff as the rest of this doc.

### 1. Think before coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- State assumptions explicitly. If uncertain, ask rather than guessing.
- If multiple interpretations exist, present them — don't silently pick one.
- If a simpler approach exists than what was asked for, say so. Push back when warranted.
- If something is unclear, stop and name what's confusing rather than proceeding on a guess.

### 2. Simplicity first

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If it's 200 lines and could be 50, rewrite it.

Test: would a senior engineer call this overcomplicated? If yes, simplify.

**Project-specific exception**: the `askAboutRegion()` backend contract (see below) is deliberately an abstraction for something that's currently single-provider (Mistral only). This is intentional, not a violation of this rule — the project's actual roadmap (Phase 4-6) requires swapping in a fine-tuned model backend later, so this abstraction is load-bearing, not speculative. Don't generalize this exception to other parts of the codebase.

### 3. Surgical changes

Touch only what you must. Clean up only your own mess.

- Don't "improve" adjacent code, comments, or formatting while making an unrelated change.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd personally do it differently.
- If you notice unrelated dead code, mention it — don't delete it unasked.
- Remove imports/variables/functions that *your* changes made unused. Don't remove pre-existing dead code unless asked.

Test: every changed line should trace directly to the user's request.

### 4. Goal-driven execution

Define success criteria. Loop until verified.

- "Add validation" → "write tests for invalid inputs, then make them pass"
- "Fix the bug" → "write a test that reproduces it, then make it pass"
- "Refactor X" → "ensure tests pass before and after"

For multi-step tasks, state a brief plan before starting:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```
Strong success criteria allow independent looping. Weak criteria ("make it work") require constant clarification — avoid them.

---

## Part 2: Project-specific context

### What this project is

A desktop tool: hold a hotkey, circle a region of the screen with the cursor, then have a short back-and-forth chat about it — type or speak, follow-up questions keep context — until you close the panel. Long-term goal: move off a hosted API and onto a fine-tuned, locally-served open vision model.

### Where things are

| Location | What it covers |
|---|---|
| `.claude/memory/decisions.md` | Locked-in decisions and why — check before proposing alternatives |
| `.claude/memory/project_state.md` | What's actually built vs. planned, read for current reality |
| `.claude/memory/phase_log.md` | Status of each implementation phase |
| `.claude/memory/todo.md` | Concrete next actions |
| `implementation_plan.md` | Full phase-by-phase plan with tools/libraries |
| `system_design_plan.md` | Architecture, components, data flow, failure modes |
| `data_pipeline.md` | How usage data flows capture → cleaning → fine-tuning → deploy → back to capture |
| `mistral_vision_query.py` | Reference implementation of the vision model call (Python) — being ported to JS for the Electron app, not called directly by it |
| `skills/` | Reusable procedures: swapping backends, dataset curation, Swan fine-tuning jobs |

### The one contract not to break

A function taking an image path and the running conversation history, returning the model's next text answer — conceptually:

```
askAboutRegion(imagePath, conversationHistory) -> answerText
```

`conversationHistory` is the growing list of `{role, content}` turns for the current chat panel session — real multi-turn, scoped to one session, not persisted after the panel closes (see `.claude/memory/decisions.md`). Current implementation language is **JS** (Electron app). Every vision backend implements this same shape. Client code (hotkey/overlay/capture/chat panel) only ever calls this — never a model SDK directly. This is what keeps Mistral swappable for a fine-tuned model later without touching the rest of the app. (`mistral_vision_query.py` is the original Python reference implementation of the single-turn version of this contract — useful for the core request logic, not for direct use; the JS port needs to extend it to carry history.)

### Keeping memory current — don't wait until a session ends

Update the memory files as you go, not just once at the end — a session can end abruptly (context limit, closed terminal, task cut short), and unrecorded progress is invisible to the next session.

- The moment a `todo.md` step's verification check passes, check it off and add anything newly surfaced — don't batch this up for later
- The moment something gets decided (not just discussed) — a tradeoff resolved, an approach chosen over an alternative — add a row to `decisions.md` immediately
- Update `project_state.md`'s "Built and working" / "Planned but not built" lists whenever something moves from one to the other
- Add a dated entry to `phase_log.md`'s Log section whenever a phase's status column changes