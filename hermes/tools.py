"""irc_* tools. Inside the gateway process they use the live adapter's link; elsewhere (CLI) they open a
short standalone link for the same account (link name ``<account>-cli``) and close it again."""
from __future__ import annotations

import asyncio
import concurrent.futures
import json
import threading
from typing import Any, Awaitable, Callable

from . import state
from .link import Delivered, LinkClient, LinkError

_TIMEOUT = 30.0


def _out(ok: bool, **kw: Any) -> str:
    return json.dumps({"ok": ok, **kw}, ensure_ascii=False)


def _run_in_thread(coro_factory: Callable[[], Awaitable[Any]], timeout: float) -> Any:
    box: dict[str, Any] = {}

    def runner() -> None:
        try:
            box["v"] = asyncio.run(coro_factory())
        except BaseException as e:  # noqa: BLE001
            box["e"] = e
    t = threading.Thread(target=runner, name="agent-comms-tool", daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        raise TimeoutError("agent-comms operation timed out")
    if "e" in box:
        raise box["e"]
    return box.get("v")


def _execute(op: Callable[[LinkClient, Any], Awaitable[Any]], *, timeout: float = _TIMEOUT, busy: bool = False) -> Any:
    """Run ``op(client, adapter_or_None)`` on the live adapter loop, or on a standalone link."""
    s = state.settings()
    if err := s.validate():
        raise LinkError(f"agent-comms not configured: {err}", retryable=False)
    adapter = state.live(s.account)
    if adapter is not None and adapter.client and adapter.client.is_open and adapter.loop and adapter.loop.is_running():
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is not adapter.loop:
            fut = asyncio.run_coroutine_threadsafe(op(adapter.client, adapter), adapter.loop)
            try:
                return fut.result(timeout + 5)
            except concurrent.futures.TimeoutError as e:
                fut.cancel()
                raise TimeoutError("agent-comms operation timed out") from e

    async def standalone() -> Any:
        async def capture(d: Delivered) -> None:
            if not collector.offer(d):
                state.inbox_append(s.account, {"from": d.sender_nick, "to": d.target, "text": d.text[:4000],
                                               "msgid": d.msgid, "time": d.time, "rel": d.rel, "why": "cli-capture"})
        collector = _Collector()
        client = LinkClient(s, link_name=f"{s.account}-cli", on_deliver=capture,
                            on_agent=lambda *_: _idle_status())
        # Replies to queries (and DMs) go only to the account's *primary* link: the most recent `busy` one. When a
        # gateway link is attached for the same account, report busy so this short-lived link receives them.
        await client.connect(initial_state="busy")
        try:
            client._collector = collector  # type: ignore[attr-defined]
            return await op(client, None)
        finally:
            try:
                await client.set_state("idle")
            except Exception:  # noqa: BLE001
                pass
            await client.close("tool done")
    return _run_in_thread(standalone, timeout + 35)


async def _idle_status() -> str:
    return "idle | Hermes CLI tool link"


class _Collector:
    def __init__(self) -> None:
        self.want: str = ""
        self.fut: asyncio.Future | None = None

    def offer(self, d: Delivered) -> bool:
        if self.fut and not self.fut.done() and d.sender_nick.lower() == self.want:
            self.fut.set_result(d)
            return True
        return False


def _guard(fn: Callable[[dict], str]) -> Callable[..., str]:
    def wrapper(args: dict | None = None, **_: Any) -> str:
        try:
            return fn(args if isinstance(args, dict) else {})
        except LinkError as e:
            return _out(False, error=str(e), hint="IRC server unreachable or refused: the message was NOT sent"
                        if e.retryable else None)
        except (TimeoutError, asyncio.TimeoutError):
            return _out(False, error="timed out")
        except Exception as e:  # noqa: BLE001
            return _out(False, error=f"{type(e).__name__}: {e}")
    return wrapper


# ── tools ────────────────────────────────────────────────────────────────────

@_guard
def irc_send(a: dict) -> str:
    target, text = str(a.get("target", "")).strip(), str(a.get("text", ""))
    if not target or not text.strip():
        return _out(False, error="target and text are required")
    reply_to = str(a.get("reply_to") or "")

    async def op(c: LinkClient, _ad: Any) -> str:
        return await c.send_message(target, text, hop=1, reply_to=reply_to)
    return _out(True, msgid=_execute(op), target=target)


@_guard
def irc_ask(a: dict) -> str:
    target, question = str(a.get("target", "")).strip(), str(a.get("question", ""))
    if not target or target.startswith("#") or not question.strip():
        return _out(False, error="target (a nick, not a channel) and question are required")
    timeout = float(min(max(int(a.get("timeout_s") or 300), 10), 1800))

    async def op(c: LinkClient, ad: Any) -> dict:
        if ad is not None:
            d = await ad.ask(target, question, timeout)
        else:
            col: _Collector = c._collector  # type: ignore[attr-defined]
            col.want, col.fut = target.lower(), asyncio.get_running_loop().create_future()
            await c.send_message(target, question, hop=1)
            d = await asyncio.wait_for(col.fut, timeout)
        return {"from": d.sender_nick, "rel": d.rel, "text": d.text, "msgid": d.msgid}
    try:
        return _out(True, answer=_execute(op, timeout=timeout, busy=True))
    except (TimeoutError, asyncio.TimeoutError):
        return _out(False, error=f"no answer from {target} within {int(timeout)}s (question was sent)")


@_guard
def irc_read(a: dict) -> str:
    limit = min(max(int(a.get("limit") or 20), 1), 200)
    channel = str(a.get("channel") or "").strip()
    s = state.settings()
    if not channel:
        return _out(True, unread=state.inbox_drain(s.account, limit))

    async def op(c: LinkClient, _ad: Any) -> list:
        lines = await c.query("CHATHISTORY", "LATEST", channel, "*", str(limit), timeout=10)
        out = []
        for ln in lines:
            if ln.command in ("PRIVMSG", "NOTICE") and len(ln.params) >= 2:
                out.append({"from": ln.nick, "text": ln.params[1], "time": ln.tag("time"), "msgid": ln.tag("msgid")})
        return out
    return _out(True, channel=channel, messages=_execute(op))


@_guard
def irc_list(a: dict) -> str:
    async def op(c: LinkClient, _ad: Any) -> list:
        lines = await c.query("LIST", timeout=10)
        return [{"channel": l.params[1], "members": int(l.params[2]) if l.params[2].isdigit() else l.params[2],
                 "topic": l.params[3] if len(l.params) > 3 else ""} for l in lines if l.command == "322" and len(l.params) >= 3]
    chans = _execute(op)
    q = str(a.get("filter") or "").lower()
    if q:
        chans = [c for c in chans if q in c["channel"].lower()]
    return _out(True, count=len(chans), channels=sorted(chans, key=lambda c: -int(c["members"]) if str(c["members"]).isdigit() else 0)[:100])


@_guard
def irc_names(a: dict) -> str:
    channel = str(a.get("channel", "")).strip()
    if not channel.startswith("#"):
        return _out(False, error="channel (#name) is required")

    async def op(c: LinkClient, _ad: Any) -> list:
        lines = await c.query("NAMES", channel, timeout=10)
        names: list[str] = []
        for l in lines:
            if l.command == "353" and l.params:
                names += [n.lstrip("@+") for n in l.params[-1].split()]
        return names
    return _out(True, channel=channel, members=_execute(op))


def _join_part(verb: str) -> Callable[..., str]:
    @_guard
    def tool(a: dict) -> str:
        channel = str(a.get("channel", "")).strip()
        if not channel.startswith("#"):
            return _out(False, error="channel (#name) is required")

        async def op(c: LinkClient, _ad: Any) -> bool:
            await c.query(verb, channel, timeout=8)
            return True
        _execute(op)
        return _out(True, channel=channel, action=verb.lower())
    return tool


irc_join = _join_part("JOIN")
irc_part = _join_part("PART")


@_guard
def irc_claims(a: dict) -> str:
    want = str(a.get("path") or "").strip()
    from .claims import canonical
    cpath = canonical(want) if want else ""
    s = state.settings()

    async def op(c: LinkClient, _ad: Any) -> list:
        await asyncio.sleep(0)  # table is filled by the server burst / live CLAIMSET broadcasts
        return [{"path": p, **v, "mine": v["holder"] == s.account} for p, v in sorted(c.claims.items())]
    rows = _execute(op)
    if cpath:
        rows = [r for r in rows if r["path"] == cpath]
    elif a.get("mine"):
        rows = [r for r in rows if r["mine"]]
    return _out(True, count=len(rows), claims=rows[:200])


@_guard
def irc_release(a: dict) -> str:
    from .claims import canonical
    s = state.settings()
    release_all = bool(a.get("all"))
    path = canonical(str(a.get("path") or "")) if a.get("path") else None
    if not release_all and not path:
        return _out(False, error="give path, or all=true to release every claim this profile holds")

    async def op(c: LinkClient, _ad: Any) -> list:
        targets = [p for p, v in c.claims.items() if v["holder"] == s.account] if release_all else [path]
        return [(p, await c.release(p)) for p in targets]
    res = _execute(op)
    return _out(True, released=[p for p, ok in res if ok], not_held=[p for p, ok in res if not ok])


def available() -> bool:
    return state.settings().validate() is None


_S = lambda props, req: {"type": "object", "properties": props, "required": req, "additionalProperties": False}  # noqa: E731
SCHEMAS = {
    "irc_send": ("Send a message to another agent or the operator on the agent-comms IRC network. "
                 "target is a nick (DM) or #channel. Address a nick inside channel text to wake that agent; "
                 "plain channel text is chatter. One point per message; put long content in a file and send "
                 "the path (16 KB limit). Don't send acknowledgements.",
                 _S({"target": {"type": "string", "description": "nick or #channel"},
                     "text": {"type": "string"},
                     "reply_to": {"type": "string", "description": "msgid being answered (optional)"}},
                    ["target", "text"])),
    "irc_ask": ("Ask another agent (by nick) a question over agent-comms and wait for its answer. Blocks "
                "until that agent replies or the timeout passes.",
                _S({"target": {"type": "string", "description": "nick of the agent to ask"},
                    "question": {"type": "string"},
                    "timeout_s": {"type": "integer", "description": "seconds to wait (10-1800, default 300)"}},
                   ["target", "question"])),
    "irc_read": ("Read agent-comms messages that did not wake you (chatter, over-limit or captured), or the "
                 "recent history of a #channel.",
                 _S({"limit": {"type": "integer"}, "channel": {"type": "string", "description": "optional #channel"}}, [])),
    "irc_list": ("List agent-comms channels (projects, agent families) with member counts.",
                 _S({"filter": {"type": "string", "description": "optional substring"}}, [])),
    "irc_names": ("List the members (agent nicks) of an agent-comms channel.",
                  _S({"channel": {"type": "string"}}, ["channel"])),
    "irc_join": ("Join an agent-comms channel.", _S({"channel": {"type": "string"}}, ["channel"])),
    "irc_part": ("Leave an agent-comms channel.", _S({"channel": {"type": "string"}}, ["channel"])),
    "irc_claims": ("List agent-comms file claims (which agent is editing which file). Your write_file/patch "
                   "edits claim files automatically and are blocked when another agent holds the file.",
                   _S({"path": {"type": "string", "description": "only this file (optional)"},
                       "mine": {"type": "boolean", "description": "only claims this profile holds"}}, [])),
    "irc_release": ("Release your agent-comms claim on a file (or all=true for every claim you hold) when you "
                    "stop working on it, so other agents can edit it.",
                    _S({"path": {"type": "string"}, "all": {"type": "boolean"}}, [])),
}
HANDLERS = {"irc_send": irc_send, "irc_ask": irc_ask, "irc_read": irc_read, "irc_list": irc_list,
            "irc_names": irc_names, "irc_join": irc_join, "irc_part": irc_part,
            "irc_claims": irc_claims, "irc_release": irc_release}
