"""
Backend adapter.

Almost every LLM server people run today — Ollama, LM Studio, OpenRouter,
NVIDIA NIM, vLLM, text-generation-webui, LocalAI, Groq, Together, etc. —
exposes (or can expose) an OpenAI-compatible `/v1/chat/completions` endpoint.
So instead of writing one adapter per provider, this is a single client
parametrized by base_url / api_key / model. The presets below just fill in
the base_url + default port for the common local/hosted options; "custom"
covers literally anything else.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Optional

import requests

# Known presets. base_url should NOT include a trailing slash.
# api_key_env: name of the environment variable holding the key (None = no key needed, e.g. local servers)
PRESETS = {
    "ollama": {
        "base_url": "http://localhost:11434/v1",
        "api_key_env": None,
        "note": "Run `ollama serve` first. Model name = whatever you `ollama pull`ed, e.g. 'llama3.1'.",
    },
    "lmstudio": {
        "base_url": "http://localhost:1234/v1",
        "api_key_env": None,
        "note": "Start the local server from LM Studio's 'Developer' tab first.",
    },
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "api_key_env": "OPENROUTER_API_KEY",
        "note": "Model names look like 'meta-llama/llama-3.1-70b-instruct'. See openrouter.ai/models.",
    },
    "nvidia": {
        "base_url": "https://integrate.api.nvidia.com/v1",
        "api_key_env": "NVIDIA_API_KEY",
        "note": "NVIDIA NIM. Model names look like 'meta/llama-3.1-70b-instruct'.",
    },
    "vllm": {
        "base_url": "http://localhost:8000/v1",
        "api_key_env": None,
        "note": "Default vLLM OpenAI-compatible server address.",
    },
    "custom": {
        "base_url": None,
        "api_key_env": None,
        "note": "Provide --base-url yourself (and --api-key-env if the endpoint needs auth).",
    },
    "omniroute": {
        "base_url": "http://localhost:20128/v1",
        "api_key_env": "OMNIROUTE_API_KEY",
        "note": "OmniRoute local inference server. Run omniroute first.",
    },
}


@dataclass
class BackendConfig:
    base_url: str
    model: str
    api_key: Optional[str] = None
    temperature: float = 0.3
    max_tokens: int = 2048
    timeout: int = 120


class ChatBackend:
    """Thin client for POST {base_url}/chat/completions."""

    def __init__(self, cfg: BackendConfig):
        self.cfg = cfg

    def chat(self, messages: list[dict], on_chunk=None) -> str:
        url = f"{self.cfg.base_url.rstrip('/')}/chat/completions"
        headers = {"Content-Type": "application/json"}
        if self.cfg.api_key:
            headers["Authorization"] = f"Bearer {self.cfg.api_key}"

        # Some config files can contain an old or accidental token value far
        # above what a backend can accept. Keep enough room for long code
        # responses without allowing one request to consume the full context.
        max_tokens = max(256, min(int(self.cfg.max_tokens), 32768))
        payload = {
            "model": self.cfg.model,
            "messages": messages,
            "temperature": self.cfg.temperature,
            "max_tokens": max_tokens,
            "stream": bool(on_chunk),
        }

        resp = requests.post(url, headers=headers, data=json.dumps(payload), timeout=self.cfg.timeout, stream=bool(on_chunk))
        if on_chunk and resp.status_code in (400, 404, 405, 422):
            # Some OpenAI-compatible servers do not implement SSE streaming.
            payload["stream"] = False
            resp = requests.post(url, headers=headers, data=json.dumps(payload), timeout=self.cfg.timeout)
        if resp.status_code != 200:
            raise RuntimeError(f"Backend error {resp.status_code} from {url}: {resp.text[:500]}")

        # OpenAI-compatible local servers occasionally omit or misreport the
        # charset. Raven's protocol payload is UTF-8; using the platform
        # default here turns accents into mojibake such as "Ã©".
        resp.encoding = "utf-8"

        if on_chunk and payload["stream"]:
            parts = []
            for line in resp.iter_lines(decode_unicode=True):
                if not line or not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if raw == "[DONE]":
                    break
                try:
                    delta = json.loads(raw)
                    content = delta.get("choices", [{}])[0].get("delta", {}).get("content") or ""
                except (json.JSONDecodeError, IndexError, AttributeError):
                    content = ""
                if content:
                    parts.append(content)
                    on_chunk(content)
            return "".join(parts)

        data = resp.json()
        try:
            return data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError) as e:
            raise RuntimeError(f"Unexpected response shape from backend: {json.dumps(data)[:500]}") from e
