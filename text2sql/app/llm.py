"""Model providers. The model only ever receives schema metadata, training text and the
user's question - see engine.build_prompt for exactly what is sent."""
import json
import re
import time
from dataclasses import dataclass

from . import security

PROVIDERS = {
    "anthropic": {"label": "Anthropic Claude", "needs_key": True, "needs_url": False},
    "openai": {"label": "OpenAI", "needs_key": True, "needs_url": False},
    "openai_compatible": {"label": "Self-hosted / OpenAI-compatible (Ollama, vLLM, LM Studio)",
                          "needs_key": False, "needs_url": True},
}


class LLMError(Exception):
    pass


@dataclass
class LLMResult:
    text: str
    input_tokens: int = 0
    output_tokens: int = 0
    ms: int = 0


def complete(model, system: str, user: str) -> LLMResult:
    """One request/response turn against the configured model."""
    key = security.decrypt(model.api_key_enc)
    t0 = time.time()
    if model.provider == "anthropic":
        res = _anthropic(model, key, system, user)
    elif model.provider in ("openai", "openai_compatible"):
        res = _openai(model, key, system, user)
    else:
        raise LLMError(f"Unknown provider: {model.provider}")
    res.ms = int((time.time() - t0) * 1000)
    return res


def _anthropic(model, key, system, user) -> LLMResult:
    import anthropic
    client = anthropic.Anthropic(api_key=key or None, base_url=model.base_url or None, timeout=120.0)
    kwargs = dict(
        model=model.model_id,
        max_tokens=16000,
        system=system,
        messages=[{"role": "user", "content": user}],
        cache_control={"type": "ephemeral"},     # the schema-heavy prefix is reused across questions
    )
    if model.effort:
        kwargs["output_config"] = {"effort": model.effort}
    try:
        resp = client.messages.create(**kwargs)
    except anthropic.AuthenticationError:
        raise LLMError("The Anthropic API key was rejected. Ask an admin to update the model's key.")
    except anthropic.PermissionDeniedError:
        raise LLMError("The Anthropic API key is not allowed to use this model.")
    except anthropic.NotFoundError:
        raise LLMError(f"Model '{model.model_id}' was not found. Check the model ID in Admin > Models.")
    except anthropic.RateLimitError:
        raise LLMError("The model provider is rate-limiting requests. Please retry in a minute.")
    except anthropic.BadRequestError as e:
        raise LLMError(f"The model rejected the request: {e.message}")
    except anthropic.APIStatusError as e:
        raise LLMError(f"Model provider error ({e.status_code}). Please retry.")
    except anthropic.APIConnectionError:
        raise LLMError("Could not reach the model provider. Check the server's network access.")
    if resp.stop_reason == "refusal":
        raise LLMError("The model declined to answer this question.")
    if resp.stop_reason == "max_tokens":
        raise LLMError("The model's answer was cut off. Try a narrower question.")
    text = "".join(b.text for b in resp.content if b.type == "text")
    u = resp.usage
    in_tok = (u.input_tokens or 0) + (getattr(u, "cache_read_input_tokens", 0) or 0) + \
             (getattr(u, "cache_creation_input_tokens", 0) or 0)
    return LLMResult(text=text, input_tokens=in_tok, output_tokens=u.output_tokens or 0)


def _openai(model, key, system, user) -> LLMResult:
    import openai
    if model.provider == "openai_compatible" and not model.base_url:
        raise LLMError("This self-hosted model has no base URL configured.")
    client = openai.OpenAI(api_key=key or "not-needed", base_url=model.base_url or None, timeout=120.0)
    try:
        resp = client.chat.completions.create(
            model=model.model_id,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        )
    except openai.AuthenticationError:
        raise LLMError("The API key was rejected. Ask an admin to update the model's key.")
    except openai.NotFoundError:
        raise LLMError(f"Model '{model.model_id}' was not found at the configured endpoint.")
    except openai.RateLimitError:
        raise LLMError("The model provider is rate-limiting requests. Please retry in a minute.")
    except openai.APIStatusError as e:
        raise LLMError(f"Model provider error ({e.status_code}): {str(e.message)[:300]}")
    except openai.APIConnectionError:
        raise LLMError("Could not reach the model endpoint. Check the base URL and network access.")
    if not resp.choices:
        raise LLMError("The model returned an empty response.")
    u = resp.usage
    return LLMResult(text=resp.choices[0].message.content or "",
                     input_tokens=getattr(u, "prompt_tokens", 0) or 0,
                     output_tokens=getattr(u, "completion_tokens", 0) or 0)


def parse_answer(text: str) -> dict:
    """Tolerant parse of the model's JSON answer -> {sql, explanation, followups, clarification, analysis}."""
    text = (text or "").strip()
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()   # some local models
    candidates = [text]
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    if m:
        candidates.insert(0, m.group(1))
    a, b = text.find("{"), text.rfind("}")
    if a != -1 and b > a:
        candidates.append(text[a:b + 1])
    for c in candidates:
        try:
            obj = json.loads(c)
        except ValueError:
            continue
        if isinstance(obj, dict) and ("sql" in obj or "clarification" in obj):
            fu = obj.get("followups") or []
            return {"sql": (obj.get("sql") or "").strip(),
                    "explanation": str(obj.get("explanation") or "").strip(),
                    "followups": [str(x).strip() for x in fu if str(x).strip()][:4] if isinstance(fu, list) else [],
                    "clarification": str(obj.get("clarification") or "").strip(),
                    "analysis": obj.get("analysis") if isinstance(obj.get("analysis"), dict) else None}
    m = re.search(r"```(?:sql)?\s*(.+?)```", text, re.S | re.I)
    if m:
        return {"sql": m.group(1).strip(), "explanation": "", "followups": [], "clarification": "", "analysis": None}
    if re.match(r"\s*(select|with)\b", text, re.I):
        return {"sql": text, "explanation": "", "followups": [], "clarification": "", "analysis": None}
    return {"sql": "", "explanation": "", "followups": [], "clarification": text[:1000], "analysis": None}
