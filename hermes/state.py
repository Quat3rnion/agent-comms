"""Shared state: settings resolution, live adapter registry, inbox persistence."""
from __future__ import annotations

import json
import os
import re
import threading
import time
from collections import deque
from typing import Any, Optional

from .link import Settings

_TRUTHY = {"1", "true", "yes", "on"}

# account -> live adapter (only in the gateway process)
LIVE: dict[str, Any] = {}
_LOCK = threading.Lock()


def _secret(name: str, default: str = "") -> str:
    try:
        from gateway.platforms._shared import get_scoped_secret
        val = get_scoped_secret(name, default)
    except Exception:  # noqa: BLE001 - CLI context without gateway scope
        val = os.environ.get(name, default)
    return str(val if val is not None else default).strip()


def _default_nick() -> str:
    home = os.environ.get("HERMES_HOME", "")
    m = re.search(r"/profiles/([^/]+)/?$", home)
    return m.group(1) if m else "hermes"


def settings(extra: Optional[dict] = None) -> Settings:
    extra = extra or {}
    get = lambda env, key, dflt="": _secret(env) or str(extra.get(key, dflt) or dflt)  # noqa: E731
    port_raw = get("AGENT_COMMS_PORT", "port", "6697")
    tls_raw = get("AGENT_COMMS_TLS", "tls", "true")
    return Settings(
        host=get("AGENT_COMMS_HOST", "host"),
        port=int(port_raw) if port_raw.isdigit() else 6697,
        use_tls=tls_raw.lower() in _TRUTHY,
        ca_file=get("AGENT_COMMS_CA_FILE", "ca_file", ""),
        token_file=get("AGENT_COMMS_TOKEN_FILE", "token_file", "~/.config/agent-comms/link-token"),
        server_name=get("AGENT_COMMS_SERVER_NAME", "server_name", "irc.agent-comms.local"),
        nick=get("AGENT_COMMS_NICK", "nick", _default_nick()),
        project=get("AGENT_COMMS_PROJECT", "project", "hermes"),
        realname=get("AGENT_COMMS_REALNAME", "realname", "Hermes Agent"),
    )


def policy() -> dict:
    def _int(env: str, dflt: int) -> int:
        v = _secret(env)
        return int(v) if v.isdigit() else dflt
    return {
        "accept": (_secret("AGENT_COMMS_ACCEPT") or "all").lower(),     # all | operator
        "hop_limit": _int("AGENT_COMMS_HOP_LIMIT", 4),
        "wake_budget": _int("AGENT_COMMS_WAKE_BUDGET", 10),
        "wake_window": _int("AGENT_COMMS_WAKE_WINDOW_SECS", 3600),
    }


def register_live(account: str, adapter: Any) -> None:
    with _LOCK:
        LIVE[account] = adapter


def unregister_live(account: str, adapter: Any) -> None:
    with _LOCK:
        if LIVE.get(account) is adapter:
            LIVE.pop(account, None)


def live(account: str) -> Any:
    with _LOCK:
        return LIVE.get(account)


# ── inbox (unread chatter / standalone captures), per account ──────────────────

def _inbox_path(account: str) -> str:
    d = os.path.expanduser("~/.hermes/cache/agent-comms")
    os.makedirs(d, mode=0o700, exist_ok=True)
    return os.path.join(d, f"inbox-{account}.jsonl")


def inbox_append(account: str, item: dict) -> None:
    with _LOCK, open(_inbox_path(account), "a", encoding="utf-8") as fh:
        fh.write(json.dumps(item) + "\n")


def inbox_drain(account: str, limit: int) -> list[dict]:
    path = _inbox_path(account)
    with _LOCK:
        if not os.path.exists(path):
            return []
        with open(path, encoding="utf-8") as fh:
            items = [json.loads(l) for l in fh if l.strip()]
        keep, out = items[:-limit] if len(items) > limit else [], items[-limit:]
        with open(path, "w", encoding="utf-8") as fh:
            fh.writelines(json.dumps(i) + "\n" for i in keep)
    return out


class WakeBudget:
    def __init__(self) -> None:
        self._events: deque[float] = deque()

    def allow(self, budget: int, window: int) -> bool:
        now = time.monotonic()
        while self._events and now - self._events[0] > window:
            self._events.popleft()
        if len(self._events) >= budget:
            return False
        self._events.append(now)
        return True
