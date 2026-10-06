---
name: dataset-pipeline
description: Use this skill when logging usage data, curating/cleaning examples, generating synthetic training data, or preparing a dataset for fine-tuning the screen-region agent's vision model. Covers the schema, the clean/filter workflow, and the train/eval split rule.
---

# Dataset Pipeline Skill

Full detail lives in `data_pipeline.md` at the project root — this is the quick-reference version for doing the work.

## The schema (every record, real or synthetic)

One record per **conversation**, not per question — a session can have several turns, all logged together once (see `system_design_plan.md` §5):

```json
{
  "id": "uuid",
  "image_crop": "path/to/crop.png",
  "image_context": "path/to/full.png or null",
  "app_hint": "vscode | browser | pdf | ... | null",
  "turns": [
    { "role": "user", "content": "string" },
    { "role": "assistant", "content": "string" }
  ],
  "category": "code | chart | ui | text | math | translation",
  "feedback": "thumbs_up | thumbs_down | null",
  "feedback_note": "string | null (Phase 2.1 — optional free-text set only alongside thumbs_down)",
  "source": "real_usage | synthetic",
  "started_at": "ISO datetime",
  "ended_at": "ISO datetime"
}
```

Every logging call, real or synthetic, writes this exact shape. Don't invent per-purpose variants — downstream fine-tuning code depends on this being consistent. Storage is a local JSONL file, one line per conversation (`localLogger.js`'s `logConversation()`) — see `.claude/memory/decisions.md` for why JSONL over SQLite.

## Workflow: cleaning real usage data

Two goals now, not one: image-reading **accuracy** and response **quality** (helpfulness, concision, tone) — in real tension with the "not conversational flair" eval stance below, named explicitly rather than blended in silently (see `.claude/memory/decisions.md`).

1. Pull all logged interactions
2. 👍 examples → usable as-is for correctness, but still worth a quality pass — a correct answer can still be verbose or badly toned, and this hand-review pass is the only place that gets caught before it becomes training data
3. 👎 examples → don't discard by default. Hand-edit the `answer` field into something both correct *and* well-written — the image+question pairing is still valuable even when the original answer wasn't. If `feedback_note` is set, read it first — it's the user's own account of what was wrong
4. Drop: near-duplicate crops, corrupted images, empty/refused answers
5. **Implicit signals, beyond explicit `feedback`/`feedback_note`** (decided 2026-08-25, not yet actionable — Phase 3 hasn't started): a user rephrasing/correcting their question right after an answer is a real negative signal — flag for priority review even without a 👎; a short conversation with no follow-up is only a weak tiebreaker signal, never ground truth alone (quick-and-correct looks identical to user-gave-up-and-left). An automated-judge pre-filter for this was considered and deferred — see `.claude/memory/decisions.md`

## Workflow: generating synthetic examples

1. Identify underrepresented categories (check the category distribution in current logged data)
2. Screenshot real examples of that category yourself
3. Use the active vision backend (see `vision-backend` skill) as an "oracle" to draft a candidate answer
4. **Always review/edit before adding** — never add oracle output straight to the training pool untouched
5. Tag `source: synthetic`

## The one rule that matters most: frozen eval set

The moment you have enough data (~30-50 examples spanning every category), carve out a held-out eval set and **never train on it, ever, in any future round**. This is what makes it possible to tell whether a fine-tune actually helped, versus just measuring memorization of the training set. If this rule gets violated even once, the eval numbers from then on are meaningless.

## Versioning

Simple is fine: `dataset_v1.jsonl`, `dataset_v2.jsonl`, etc. The goal is just being able to answer "which dataset produced this checkpoint" when comparing fine-tune runs later.

## Format conversion for training

The schema above is the logging/storage format — it is NOT the format Unsloth/HF expect for training. Conversion to conversation-turn + image format happens as a separate deterministic script, run once per dataset version, right before kicking off a fine-tune job.
