# Data Pipeline — Screen-Region AI Agent

This traces data from the moment someone circles something on screen through to it becoming part of a fine-tuning run, and back again. It's the connective tissue between Phase 2 (instrumentation), Phase 3 (dataset curation), and Phase 4 (fine-tuning) in the implementation plan.

```
┌──────────────┐
│ 1. CAPTURE   │  Every real interaction: crop + context image, question, answer
└──────┬───────┘
       ▼
┌──────────────┐
│ 2. LOG       │  Written to local SQLite/JSONL in the standard schema
└──────┬───────┘
       ▼
┌──────────────┐
│ 3. LABEL     │  👍/👎 from the popup; unlabeled = lowest trust tier
└──────┬───────┘
       ▼
┌──────────────┐
│ 4. FILTER &  │  Keep 👍 as-is; hand-edit 👎 into good examples or discard;
│    CLEAN     │  drop duplicates, blurry crops, empty answers
└──────┬───────┘
       ▼
┌──────────────┐
│ 5. AUGMENT   │  Synthetic examples generated via Mistral-as-oracle to fill
│    (synthetic)│  gaps in category coverage (chart/code/ui/text/math/translation)
└──────┬───────┘
       ▼
┌──────────────┐
│ 6. SPLIT     │  Train set vs. held-out eval set (eval set frozen, never
│              │  touched by future training rounds)
└──────┬───────┘
       ▼
┌──────────────┐
│ 7. VERSION   │  Snapshot as dataset vN (DVC or just a dated folder/file)
└──────┬───────┘
       ▼
┌──────────────┐
│ 8. FORMAT    │  Convert JSONL → the conversation/image format Unsloth expects
│    CONVERT   │
└──────┬───────┘
       ▼
┌──────────────┐
│ 9. TRAIN     │  QLoRA fine-tune on Swan (Qwen2.5-VL-7B + Unsloth)
└──────┬───────┘
       ▼
┌──────────────┐
│ 10. EVAL     │  Run base vs. fine-tuned on the frozen held-out set
└──────┬───────┘
       ▼
┌──────────────┐
│ 11. DEPLOY   │  Swap the new checkpoint into local/served inference
└──────┬───────┘
       ▼
   (back to 1) — new real usage under the improved model feeds the next round
```

---

## Stage details

### 1–2. Capture & Log
One record per **conversation**, not per question — a session can have several back-and-forth turns, all sharing the same image and logged together once the chat panel closes (from the system design doc, §5):

```json
{
  "id": "uuid",
  "image_crop": "path/to/crop.png",
  "image_context": "path/to/full.png",
  "app_hint": "vscode",
  "turns": [
    { "role": "user", "content": "what does this error mean" },
    { "role": "assistant", "content": "..." }
  ],
  "category": "code",
  "feedback": "thumbs_up",
  "feedback_note": null,
  "source": "real_usage",
  "started_at": "2026-08-08T10:00:00Z",
  "ended_at": "2026-08-08T10:00:12Z"
}
```
This is written locally (JSONL, one line per conversation — see `.claude/memory/decisions.md` for why JSONL over SQLite) once the chat panel closes, after every turn's Mistral call has already happened — not at capture time, since the conversation isn't complete until the panel closes.

### 3–4. Label, Filter, Clean
Fine-tuning is training for two things now, not one — image-reading **accuracy** and response **quality** (helpfulness, concision, tone). The two goals are in real tension with Phase 5's existing "not conversational flair" eval stance (a terse-but-correct answer is still meant to beat a fluent-but-wrong one) — named explicitly here rather than silently blended in; see `.claude/memory/decisions.md`. In practice that means this hand-review pass edits for *both* now:

- 👍 examples: usable as-is for factual correctness, but **still worth a quality pass** — a correct answer can still be verbose, oddly toned, or unhelpfully terse, and it's captured as good data (positive label) either way if left unedited, so this is the only place quality issues in an already-correct answer get caught
- 👎 examples: don't discard by default — hand-edit the answer into something both correct *and* well-written, since the *question + image* pairing is still valuable, only the answer was bad. If `feedback_note` (Phase 2.1) is set, read it first — it's the user's own word on what was actually wrong, a cheaper starting point than re-diagnosing from scratch
- Cleaning pass: drop near-duplicate crops, corrupted images, empty/refused answers

**Implicit signals worth prioritizing, beyond explicit `feedback`/`feedback_note`** (decided 2026-08-25, not yet actionable until Phase 3 actually starts — see `.claude/memory/decisions.md`):
- A user rephrasing or correcting their question right after getting an answer ("no I meant...", "that's not right") — a real, likely-more-reliable-than-self-report negative signal. Flag for priority review even on conversations with no 👎 ever clicked.
- A short conversation with no follow-up — only a weak, genuinely ambiguous signal (quick-and-correct looks identical to user-gave-up-and-left from turn count alone). Usable at most as a tiebreaker between otherwise-similar review candidates, never as ground truth on its own.

An automated-judge-based pre-filter (extending Phase 5's Mistral-as-judge to also triage curation volume) was considered and explicitly deferred, not dropped — see decisions.md for why and its revisit trigger.

This is the stage most worth doing manually early on — a few hundred *hand-reviewed* examples beat a few thousand unreviewed ones for a first fine-tune.

### 5. Synthetic augmentation
Real usage will skew toward whatever you personally do most. Use Mistral to generate additional Q&A pairs for underrepresented categories (e.g., you rarely circle math problems, but want the model to handle them) — screenshot the case yourself, prompt Mistral for a candidate answer, review/edit it, add it to the pool tagged `source: synthetic`.

### 6. Train/eval split
Carve out 30–50 examples spanning every category as a **frozen eval set** the moment you have enough data — before any fine-tuning happens. Never train on these, ever, across any future round. This is what lets Phase 5 evaluation actually mean something instead of just measuring memorization.

### 7. Versioning
Even a simple `dataset_v1.jsonl`, `dataset_v2.jsonl` convention works early. The point is being able to answer "which dataset produced this checkpoint" later when comparing fine-tune runs.

### 8. Format conversion
Unsloth/HF expect a specific conversation-turn + image format, not your raw logging schema. This is a small deterministic script — write it once, rerun per dataset version.

### 9–10. Train & Eval
Covered in Phases 4–5 of the implementation plan — SLURM job on Swan, then base-vs-fine-tuned comparison on the frozen eval set.

### 11. Deploy → back to 1
Once a fine-tuned checkpoint passes eval, it becomes the model answering real queries — and *those* new interactions flow back into step 1, so the pipeline is a loop, not a one-time process. Each round's usage data is what makes the next fine-tune better.

---

## What to build first

You don't need steps 5–11 working on day one. The only thing that needs to exist for Phase 1 is **step 1–2**: capture and log every interaction in the schema above. Everything downstream can be built once you actually have data flowing in.
