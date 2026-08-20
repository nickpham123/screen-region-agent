"""
Vision model inference via Mistral's La Plateforme API.

Third backend option alongside local_vision_query.py (MLX) and
hf_vision_query.py (Hugging Face) — same ask_about_region() signature so
your popup pipeline doesn't care which one is active.

Note: standalone Pixtral 12B was deprecated (Dec 2025). Vision capability
is now folded into Mistral Small 4 (released Mar 2026), used here via the
"mistral-small-latest" alias. If Mistral renames things again, check
https://docs.mistral.ai/getting-started/models/ for the current alias.

Requirements:
    pip install mistralai

Setup:
    1. Sign up at https://console.mistral.ai (phone verification required)
    2. Generate an API key from the dashboard
    3. export MISTRAL_API_KEY=your_key_here

Free tier note: rate-limited "Experiment" tier, roughly 1B tokens/month.
Data may be used for model improvement unless you opt out in console
settings — fine for testing with your own screenshots, worth revisiting
before running real users' data through it.
"""

import base64
import os
from pathlib import Path

MODEL_ID = "mistral-small-latest"

_client = None


def _get_client():
    global _client
    if _client is None:
        from mistralai import Mistral

        api_key = os.environ.get("MISTRAL_API_KEY")
        if not api_key:
            raise RuntimeError(
                "Set the MISTRAL_API_KEY environment variable. "
                "Get a key at https://console.mistral.ai"
            )
        _client = Mistral(api_key=api_key)
    return _client


def _encode_image(image_path: str | Path) -> str:
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def ask_about_region(image_path: str | Path, question: str) -> str:
    """
    Send a cropped screen-region image + a question to Mistral's vision
    model, return the text answer. Same signature as the MLX and HF
    versions — swap the import to switch backends.
    """
    client = _get_client()
    b64_image = _encode_image(image_path)

    ext = Path(image_path).suffix.lower().lstrip(".")
    mime = "jpeg" if ext in ("jpg", "jpeg") else "png"

    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": question},
                {
                    "type": "image_url",
                    "image_url": f"data:image/{mime};base64,{b64_image}",
                },
            ],
        }
    ]

    response = client.chat.complete(model=MODEL_ID, messages=messages)
    return response.choices[0].message.content


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        print("Usage: python mistral_vision_query.py <image_path> <question>")
        sys.exit(1)

    img_path, question = sys.argv[1], sys.argv[2]
    answer = ask_about_region(img_path, question)
    print(answer)
