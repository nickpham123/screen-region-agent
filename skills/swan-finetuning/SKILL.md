---
name: swan-finetuning
description: Use this skill when preparing, submitting, monitoring, or debugging a fine-tuning job on UNL HCC's Swan cluster for this project's vision model (Qwen2.5-VL-7B via Unsloth/QLoRA). Covers SLURM job structure, environment setup, and checkpointing conventions.
---

# Swan Fine-Tuning Skill

## Context

Swan is UNL Holland Computing Center's SLURM-based HPC cluster. It's free (via the user's university access) but shared and preemptible — unlike a rented cloud GPU, availability isn't guaranteed and jobs can queue or be interrupted.

## Before submitting anything

1. Confirm current GPU partition names and available modules — these drift, don't assume the illustrative script below is exactly correct. Check HCC's docs or run `sinfo` for current partition info.
2. Prefer an **interactive session** for first-time debugging of a new script, not a batch job — you want to see failures live, not discover them after a queued job finally starts.
3. Confirm the dataset version being used (see `dataset-pipeline` skill) — always know which `dataset_vN.jsonl` is feeding a given run.

## Environment setup

- Use `conda` or HCC's `module load` system to isolate the training environment from the shared login node
- Core stack: PyTorch, `transformers`, `peft`, `bitsandbytes`, `trl`, Unsloth
- The login node is for light tasks only (submitting jobs, moving files) — never run training directly on it

## Illustrative SLURM job shape

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

Confirm partition/module names against current HCC docs before relying on this verbatim.

## Checkpointing (non-negotiable given Swan is preemptible)

- Save LoRA adapter checkpoints periodically during training, not just at the end
- Log which dataset version + hyperparameters produced each checkpoint
- If a job gets killed mid-run, the last checkpoint should be resumable, not a total loss

## Experiment tracking

Use Weights & Biases or TensorBoard to track loss curves across runs — this matters once you're doing more than one fine-tune attempt, since you'll want to compare runs against each other, not just eyeball a single loss curve.

## After training: always eval before deploying

Never treat a completed training run as done — run the base model and the new checkpoint against the frozen eval set (see `dataset-pipeline` skill) before swapping it into anything user-facing. A completed run is not the same as an improved model.
