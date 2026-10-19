"""File claims for Hermes: claim a path on agent-comms before write_file / patch edits it.

A refusal (another agent outside this family holds the path) blocks the tool call with the holder's nick.
Mirrors the opencode plugin (ADR 0004) except that Hermes claims *before* the edit, which makes the claim
itself the conflict check. ``terminal`` commands are not covered (paths can't be extracted reliably).
"""
from __future__ import annotations

import datetime
import logging
import os
import re
from typing import Any, Optional

from . import state

logger = logging.getLogger("agent_comms.claims")

_EDIT_TOOLS = {"write_file", "patch"}
_V4A_RE = re.compile(r"^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$", re.M)


def _enabled() -> bool:
    return (state._secret("AGENT_COMMS_CLAIMS") or "on").lower() not in ("0", "off", "false", "no")


def _fail_mode() -> str:
    return (state._secret("AGENT_COMMS_CLAIM_FAIL_MODE") or "open").lower()   # open | deny


def _excluded_roots() -> list[str]:
    roots = [os.path.expanduser("~/.hermes"), "/tmp", "/private/tmp", "/private/var/folders", "/var/folders"]
    if os.environ.get("TMPDIR"):
        roots.append(os.environ["TMPDIR"])
    extra = state._secret("AGENT_COMMS_CLAIM_EXCLUDE")
    roots += [os.path.expanduser(p) for p in extra.split(":") if p.strip()]
    return [os.path.realpath(r) for r in roots]


def _base_dir() -> str:
    return os.environ.get("TERMINAL_CWD") or os.getcwd()


def canonical(path: str) -> Optional[str]:
    path = (path or "").strip()
    if not path or "\x00" in path or "\n" in path or "\r" in path:
        return None
    p = os.path.expanduser(path)
    if not os.path.isabs(p):
        p = os.path.join(_base_dir(), p)
    p = os.path.realpath(p)
    return p if len(p.encode()) <= 4096 else None


def target_paths(tool_name: str, args: dict) -> list[str]:
    short = tool_name.split("__")[-1]
    if short not in _EDIT_TOOLS or not isinstance(args, dict):
        return []
    raw: list[str] = []
    if isinstance(args.get("path"), str):
        raw.append(args["path"])
    if short == "patch" and isinstance(args.get("patch"), str):
        raw += _V4A_RE.findall(args["patch"])
    out, roots = [], _excluded_roots()
    for r in raw:
        c = canonical(r)
        if c and not any(c == root or c.startswith(root + os.sep) for root in roots) and c not in out:
            out.append(c)
    return out


def _when(ts: int) -> str:
    return datetime.datetime.fromtimestamp(ts).strftime("%H:%M") if ts else "?"


def pre_tool_call(tool_name: str = "", args: Optional[dict] = None, **_: Any) -> Optional[dict]:
    """Plugin hook: returns {"action": "block", "message": ...} when a path is claimed by another agent."""
    if not _enabled():
        return None
    paths = target_paths(tool_name, args or {})
    if not paths:
        return None
    s = state.settings()
    if s.validate() is not None:
        return None
    from . import tools  # local import: tools imports state too

    async def op(c, _ad):
        return [await c.claim(p) for p in paths]
    try:
        results = tools._execute(op, timeout=15)
    except Exception as e:  # noqa: BLE001 - server unreachable / timeout
        logger.warning("agent-comms: claim check failed for %s: %s", paths, e)
        if _fail_mode() == "deny":
            return {"action": "block", "message": (
                f"Edit blocked: the agent-comms claim server is unreachable ({e}) and "
                "AGENT_COMMS_CLAIM_FAIL_MODE=deny. Retry later or ask the operator.")}
        return None
    refused = [r for r in results if not r["granted"]]
    if not refused:
        return None
    lines = [f"- {r['path']} is claimed by {r['nick']} since {_when(r['since'])}" for r in refused]
    nicks = sorted({r["nick"] for r in refused})
    return {"action": "block", "message": (
        "Edit blocked by agent-comms file claim(s):\n" + "\n".join(lines) + "\n"
        f"Another agent is working on this file. Coordinate first: irc_ask target={nicks[0]} "
        "(or ask your user / the operator). Claims expire after 10 minutes of the holder's inactivity; "
        "the operator can force-release them.")}
