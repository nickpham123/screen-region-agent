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
Every interaction — real or synthetic — lands in the same schema (from the system design doc):

```json
{
  "id": "uuid",
  "image_crop": "path/to/crop.png",
  "image_context": "path/to/full.png",
  "app_hint": "vscode",
  "question": "what does this error mean",
  "answer": "...",
  "category": "code",
  "feedback": "thumbs_up",
  "source": "real_usage",
  "timestamp": "2026-08-08T10:00:00Z"
}
```
This is written locally (SQLite/JSONL) at capture time — no network round-trip needed beyond the Mistral call that produced the answer.

### 3–4. Label, Filter, Clean
- 👍 examples: usable as-is for training
- 👎 examples: don't discard by default — hand-edit the answer into something correct, since the *question + image* pairing is still valuable, only the answer was bad
- Cleaning pass: drop near-duplicate crops, corrupted images, empty/refused answers

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
