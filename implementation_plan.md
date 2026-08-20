# Screen-Region AI Agent — Full Implementation Plan

## Architecture at a glance

```
[Hotkey held] -> [Selection overlay] -> [Screen capture/crop]
      -> [Question input (typed/voice)] -> [Mistral vision API]
      -> [Popup output]
                |
                v
      [Usage logger -> dataset.jsonl]
                |
                v
      [Fine-tuning on Swan HPC via Unsloth on Qwen2.5-VL-7B] -> [LoRA adapter]
                |
                v
      [Swap into local/served fine-tuned model for future use]
```

Two different models play two different roles here, worth keeping straight:
- **Mistral (`mistral-small-latest`)** — hosted API, used now to validate the product idea fast, and later doubles as the "oracle" model that helps generate synthetic training data.
- **Qwen2.5-VL-7B** — the open-source model you'll eventually fine-tune on Swan so the agent can run locally/self-hosted instead of depending on a hosted API forever.

---

## Phase 0 — Scope decisions (locked in)

| Decision | Choice |
|---|---|
| OS target for v1 | **macOS** — resolved |
| Selection shape | Freeform gesture in the UI, but capture always uses the bounding box of the drawn path — not a true polygon mask. Resolved, see decisions.md. |
| Context sent to model | Cropped region **and** full screenshot (crop = primary, full = secondary context) |
| Output | Popup only for v1. TTS is opt-in later. |
| Prototype model | **Mistral API (`mistral-small-latest`)** — decided, no longer evaluating alternatives |
| App shell | **Electron** — decided over Tauri (built-in `globalShortcut`/`desktopCapturer` APIs match this app's needs directly) and over native Python/PyQt (avoids a second language stack) |

---

## Phase 1 — Desktop prototype (Electron + Mistral-backed)

Goal: hold hotkey → drag box → release → popup shows an answer.

| Component | Tool/Library | Why |
|---|---|---|
| Global hotkey listener | **`globalShortcut`** (built into Electron) | Detects key-held state to enter selection mode, works while any app is focused |
| Screen overlay (selection UI) | Transparent, click-through **`BrowserWindow`** + HTML/CSS/JS | Draw the drag-box while key is held |
| Screen capture | **`desktopCapturer`** (built into Electron) | Region capture, no separate library needed |
| Image handling | Node's `canvas`/Buffer APIs, or a small image lib if cropping needs more control | Crop, resize, encode to base64 for API payload |
| Chat Panel (text + voice, multi-turn) | A `BrowserWindow` popup that takes focus on open, stays open for the whole session; auto-focused text field; voice via **`whisper-node-addon`** (local whisper.cpp bindings, Metal-accelerated on Apple Silicon), held with the same key used for region selection | Crop alone doesn't convey intent, and follow-ups need context — this is a real multi-turn chat while the panel is open, not a single question/answer. Merges what earlier drafts split into a separate question popup and answer popup. Web Speech API was tried first for voice, found fundamentally broken in Electron (see decisions.md); local whisper.cpp fixes both that and the privacy tradeoff — audio never leaves the device |
| Vision model call | Mistral's REST API via `fetch` (Node has this built in) | JS port of `mistral_vision_query.py` — now takes the running conversation history, not just one question, so follow-ups have context (see `askAboutRegion()` contract in system_design_plan.md) |
| App packaging (later) | **`electron-builder`** or **`electron-forge`** | Only needed once distributing beyond your own machine |

**Already built (Python reference, being ported)**: `mistral_vision_query.py` — exposes `ask_about_region(image_path, question)`. The JS port of this is what the overlay/popup pipeline actually calls once a selection is made — see `.claude/memory/decisions.md` for why it's a port rather than a subprocess call.

---

## Phase 2 — Instrumentation (build alongside Phase 1)

| Component | Tool/Library | Why |
|---|---|---|
| Local storage | **SQLite** or flat **JSONL** files | No backend needed yet; simple append-only log |
| Schema | id, image_crop, image_context, app_hint, question, answer, category, source | Keeps Phase 1 logs directly reusable as fine-tuning data later |
| Feedback capture | Simple 👍/👎 buttons in the popup widget | Cheap quality signal without a rating system |
| Active app detection (optional) | **`pywin32`** (Windows) / **`pygetwindow`** or **Quartz** (macOS) | Auto-tag `app_hint` for free |

---

## Phase 3 — Dataset curation & synthetic bootstrapping

| Component | Tool/Library | Why |
|---|---|---|
| Synthetic data generation | Reuse **Mistral API** as an "oracle" to draft Q&A pairs from screenshots you collect manually | Bootstraps volume before real usage data exists |
| Data review/cleaning | Plain script or a lightweight **Streamlit** app to page through examples and edit answers | Quality control matters more than volume |
| Dataset versioning | **DVC** (optional) | Track which dataset version produced which fine-tune |
| Format conversion | Script to convert JSONL → the format Unsloth/HF expects | Needed right before training |

Target before first fine-tune: a few hundred clean, diverse examples spanning code / chart / UI / text / math / translation categories.

---

## Phase 4 — Fine-tuning on UNL HCC Swan

| Component | Tool/Library | Why |
|---|---|---|
| Job scheduler | **SLURM** (`sbatch`, `srun`) | How Swan allocates GPU nodes |
| Environment management | **conda** or HCC's `module load` system | Isolate your training environment from the shared system |
| Base model | **Qwen2.5-VL-7B-Instruct** (Hugging Face Hub) | Best open VLM for OCR/grounding at a fine-tunable size |
| Fine-tuning framework | **Unsloth** | Faster training, lower VRAM, simplified LoRA/QLoRA setup |
| Underlying ML libraries | **PyTorch**, **`transformers`**, **`peft`**, **`bitsandbytes`**, **`trl`** | Core fine-tuning stack under the hood |
| Experiment tracking | **Weights & Biases** or **TensorBoard** | Track loss curves, compare fine-tune attempts |
| Checkpointing | Periodic LoRA adapter checkpoints | Swan is shared/preemptible — don't lose progress to a killed job |

**Illustrative SLURM job** (confirm exact partition/module names against HCC docs):
```bash
#!/bin/bash
#SBATCH --partition=gpu
#SBATCH --gres=gpu:1
#SBATCH --mem=64G
#SBATCH --time=04:00:00
#SBATCH --job-name=vlm-finetune

module load anaconda
conda activate vlm-finetune
python train_lora.py --config configs/qwen_vl_lora.yaml
```

---

## Phase 5 — Evaluation

**What fine-tuning is actually optimizing for**: how accurately the model reads what's in the image and how well it responds to the question — not conversational flair, not general knowledge. Keep this front-of-mind when scoring; a fluent-sounding answer that misreads the screenshot is a failure, and a terse-but-correct answer is a win.

| Component | Tool/Library | Why |
|---|---|---|
| Held-out eval set | 30–50 fixed examples spanning your categories, never used in training | Consistent way to tell if a fine-tune helped |
| Scoring | Manual initially, scored specifically on (1) did it correctly read the image content, (2) did it answer what was actually asked; later use Mistral as an automated LLM-judge against these same two criteria | Automates comparison across fine-tune iterations, without drifting toward rewarding style over accuracy |
| Comparison | Script running base model vs. fine-tuned model on the same eval set | Confirms improvement, catches regressions/overfitting |

---

## Phase 6 — Serving the fine-tuned model

| Component | Tool/Library | Why |
|---|---|---|
| Local/private inference | **Ollama** or **vLLM** | Fast local serving, keeps sensitive screen content on-device |
| Merging LoRA into base (optional) | **`peft`**'s merge utility | Produces a single deployable model instead of base+adapter |
| Fallback | Keep the Mistral API path as backup for when local inference isn't available/fast enough | Reliability |

---

## Phase 7 — If/when you have real users

The architecture shifts from single-user local script to client-server. Full breakdown below; headline points:

- **Privacy is the #1 design constraint** — this app captures arbitrary screen content, so local-only mode, clear capture indicators, and no silent retention need to be built in from the start, not retrofitted.
- **Database/backend: Supabase** — Postgres + Auth + Storage + Edge Functions, fully managed. This meaningfully simplifies the earlier tier breakdown: Tier 1 no longer needs a separately-hosted FastAPI service at all — Supabase Edge Functions (Deno, serverless) can handle the thin routing/business logic layer (auth check → forward query to Mistral/fine-tuned model → log usage to Postgres), with nothing for you to deploy or keep running yourself.
- **Growth tiers** — don't build Tier 3 infra before you need it:
  - *Tier 1 (10–50 friends/beta testers)*: Supabase (Auth + Postgres for usage logs + Edge Functions for routing), Mistral or your fine-tuned model as the backend. No separate server to host or maintain.
  - *Tier 2 (100s–1000s of users)*: add Stripe billing (Supabase doesn't include this), rate limiting (start with a Postgres counter table via Edge Functions; move to Redis only if that genuinely becomes a bottleneck), move model serving off Swan onto serverless GPU hosting (Modal/Baseten/Replicate/RunPod Serverless), code signing + notarization for distribution, Sentry + PostHog for observability
  - *Tier 3 (larger/business)*: multi-region inference, enterprise on-device privacy tier, SOC 2 groundwork, dedicated support — likely the point where Edge Functions stop being enough and a real backend service (FastAPI or similar) becomes worth the added ops burden

### Deployment plan

Four separate things get deployed, on different timelines:

| What | When | How |
|---|---|---|
| **Desktop app itself** | Phase 1, for your own use | Run directly via `electron .` in dev — no packaging needed yet |
| **Desktop app, packaged for others** | As soon as anyone besides you runs it | `electron-builder` or `electron-forge` → produces a `.dmg`. Requires an Apple Developer ID (paid, $99/yr) for code signing + notarization — macOS Gatekeeper blocks unsigned apps outright, this isn't optional once it's not just your own machine. Auto-updates via `electron-updater`, pointed at either GitHub Releases (simplest for a solo project) or Supabase Storage |
| **Backend (Supabase)** | Phase 7, Tier 1+ | No traditional deploy step — create a Supabase project, define the Postgres schema (users, usage logs, billing status), write Edge Functions for the routing logic. Supabase hosts all of it |
| **Marketing website** | Whenever you build it (currently deferred, see decisions.md) | Static site or Next.js on Vercel or Netlify — separate small project from the app itself, points people toward downloading the desktop app |

Model serving deployment is already covered in Phase 6 above (Ollama/vLLM locally, serverless GPU hosting once traffic demands it) — not duplicated here.

---

## Full tool/library reference list

**Desktop app**: Electron (`globalShortcut`, `desktopCapturer`, `BrowserWindow`), `electron-builder`/`electron-forge`, Apple Developer ID (code signing + notarization), `electron-updater`

**Vision model (Phase 1–3)**: Mistral REST API via `fetch`, `mistral-small-latest` — `mistral_vision_query.py` is the Python reference being ported to JS

**Data/logging**: `sqlite3`, JSONL, Streamlit (review UI), DVC (optional)

**Fine-tuning (Phase 4)**: SLURM, conda, Qwen2.5-VL-7B-Instruct, Unsloth, PyTorch, `transformers`, `peft`, `bitsandbytes`, `trl`, Weights & Biases

**Serving (Phase 6)**: Ollama, vLLM, Mistral API (fallback)

**Production (Phase 7)**: Supabase (Auth, Postgres, Storage, Edge Functions), Stripe, Redis (only if needed beyond Tier 1), Modal/Baseten/Replicate/RunPod Serverless, Sentry, PostHog

**Marketing site (deferred)**: Vercel or Netlify

---

## Rough sequencing

1. Phase 0 decisions — done
2. Phase 1 prototype — 1–2 weeks (Mistral backend logic already validated in Python via `mistral_vision_query.py`; JS port + Electron scaffold not yet started)
3. Phase 2 instrumentation — built alongside Phase 1
4. Phase 3 dataset bootstrap — a few days, once Phase 1 is usable
5. Phase 4 first fine-tune on Swan — a few days (mostly queue/training wait time)
6. Phase 5 eval — 1 day
7. Phase 6 serving swap — 1–2 days
8. Phase 7 productionization — only once you're ready for users beyond yourself
9. Repeat 3–5 as a loop as more usage data comes in