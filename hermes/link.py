"""agent-comms link protocol v1 client (see Quat3rnion/agent-comms docs/link-protocol.md).

Pure asyncio + stdlib. Used by the gateway adapter (long-lived link) and by the tools'
standalone fallback (short-lived link when no gateway adapter runs in this process).
The link token is read from a file on every connect and never logged.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import itertools
import logging
import os
import re
import secrets
import ssl
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger("agent_comms.link")

PROTOCOL_VERSION = 1
_TAG_UNESCAPE = {":": ";", "s": " ", "\\": "\\", "r": "\r", "n": "\n"}
_TAG_ESCAPE = {";": "\\:", " ": "\\s", "\\": "\\\\", "\r": "\\r", "\n": "\\n"}
MAX_MESSAGE_BYTES = 16384


# ── line codec ────────────────────────────────────────────────────────────────

@dataclass
class Line:
    command: str
    params: list[str] = field(default_factory=list)
    tags: dict[str, Optional[str]] = field(default_factory=dict)
    source: str = ""

    @property
    def nick(self) -> str:
        return self.source.split("!", 1)[0]

    def tag(self, key: str, default: Optional[str] = None) -> Optional[str]:
        return self.tags.get(key, default)


def _unescape(value: str) -> str:
    out, it = [], iter(value)
    for ch in it:
        if ch == "\\":
            nxt = next(it, "")
            out.append(_TAG_UNESCAPE.get(nxt, nxt))
        else:
            out.append(ch)
    return "".join(out)


def parse(raw: str) -> Line:
    raw = raw.rstrip("\r\n")
    tags: dict[str, Optional[str]] = {}
    if raw.startswith("@"):
        tag_str, _, raw = raw[1:].partition(" ")
        for item in tag_str.split(";"):
            if not item:
                continue
            k, eq, v = item.partition("=")
            tags[k] = _unescape(v) if eq else None
        raw = raw.lstrip(" ")
    source = ""
    if raw.startswith(":"):
        source, _, raw = raw[1:].partition(" ")
        raw = raw.lstrip(" ")
    params: list[str] = []
    while raw:
        if raw.startswith(":"):
            params.append(raw[1:])
            break
        part, _, raw = raw.partition(" ")
        if part:
            params.append(part)
        raw = raw.lstrip(" ")
    command = params.pop(0).upper() if params else ""
    return Line(command=command, params=params, tags=tags, source=source)


def build(command: str, *params: str, tags: Optional[dict[str, Optional[str]]] = None) -> str:
    """Canonical form: ``:`` only on a last param that is empty, has a space, or starts with ``:``."""
    parts = []
    if tags:
        parts.append("@" + ";".join(
            k if v is None else f"{k}=" + "".join(_TAG_ESCAPE.get(c, c) for c in v) for k, v in tags.items()))
    parts.append(command)
    for i, p in enumerate(params):
        last = i == len(params) - 1
        if last and (p == "" or " " in p or p.startswith(":")):
            parts.append(":" + p)
        else:
            if " " in p or not p:
                raise ValueError(f"middle param must be non-empty and space-free: {p!r}")
            parts.append(p)
    return " ".join(parts)


def sanitize(text: str) -> str:
    return text.replace("\x00", "").replace("\r", "")


# ── server identity proof ──────────────────────────────────────────────────────

def server_key(token: str) -> str:
    return hmac.new(token.encode(), b"agent-comms server key v1", hashlib.sha256).hexdigest()


def expected_proof(token: str, nonce: str, server_name: str) -> str:
    msg = f"agent-comms link proof v1|{nonce}|{server_name}".encode()
    return hmac.new(bytes.fromhex(server_key(token)), msg, hashlib.sha256).hexdigest()


# ── settings ────────────────────────────────────────────────────────────────────

_NICK_RE = re.compile(r"^[A-Za-z_\-\[\]\\`^{}|][A-Za-z0-9_\-\[\]\\`^{}|]{0,95}$")
_SLUG_RE = re.compile(r"^[a-z0-9-]{1,64}$")


@dataclass
class Settings:
    host: str
    port: int = 6697
    use_tls: bool = True
    ca_file: str = ""
    token_file: str = "~/.config/agent-comms/link-token"
    server_name: str = "irc.agent-comms.local"
    nick: str = "hermes"
    project: str = "hermes"
    realname: str = "Hermes Agent"

    @property
    def account(self) -> str:
        return "hermes-" + re.sub(r"[^A-Za-z0-9_-]", "-", self.nick)[:56]

    @property
    def link_name(self) -> str:
        return self.account

    def validate(self) -> Optional[str]:
        if not self.host:
            return "AGENT_COMMS_HOST is not set"
        if not _NICK_RE.match(self.nick):
            return f"invalid nick {self.nick!r}"
        if not _SLUG_RE.match(self.project):
            return f"invalid project slug {self.project!r}"
        if not os.path.isfile(os.path.expanduser(self.token_file)):
            return f"link token file not found: {self.token_file}"
        if self.use_tls and self.ca_file and not os.path.isfile(os.path.expanduser(self.ca_file)):
            return f"CA file not found: {self.ca_file}"
        return None

    def read_token(self) -> str:
        with open(os.path.expanduser(self.token_file), encoding="utf-8") as fh:
            return fh.read().strip()

    def ssl_context(self) -> Optional[ssl.SSLContext]:
        if not self.use_tls:
            return None
        ctx = ssl.create_default_context(cafile=os.path.expanduser(self.ca_file) if self.ca_file else None)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        return ctx


class LinkError(Exception):
    """Handshake/protocol failure. ``retryable`` is False for credential/config problems."""

    def __init__(self, message: str, *, retryable: bool = True):
        super().__init__(message)
        self.retryable = retryable


# ── link client ───────────────────────────────────────────────────────────────

DeliverCb = Callable[["Delivered"], Awaitable[None]]
AgentCb = Callable[[str, str, str], Awaitable[str]]


@dataclass
class Delivered:
    """One logical message for our account (multiline batches already joined)."""
    command: str            # PRIVMSG | NOTICE
    sender_nick: str
    sender_account: str
    target: str             # our nick (DM) or #channel
    text: str
    msgid: str
    time: str
    role: str               # operator | agent
    rel: str                # operator | ancestor | descendant | peer
    broadcast: Optional[str]
    hop: int
    replayed: bool = False

    @property
    def is_dm(self) -> bool:
        return not self.target.startswith(("#", "&"))


class LinkClient:
    """One link connection carrying exactly one account (this Hermes profile)."""

    def __init__(self, settings: Settings, *, link_name: Optional[str] = None,
                 on_deliver: Optional[DeliverCb] = None, on_agent: Optional[AgentCb] = None,
                 on_other: Optional[Callable[[Line], Awaitable[None]]] = None):
        self.s = settings
        self.link_name = link_name or settings.link_name
        self.on_deliver, self.on_agent, self.on_other = on_deliver, on_agent, on_other
        self.nick = settings.nick
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._recv_task: Optional[asyncio.Task] = None
        self._ka_task: Optional[asyncio.Task] = None
        self._labels = itertools.count(1)
        self._pending: dict[str, asyncio.Future] = {}          # outer label -> SENT/SENDFAIL/FAIL
        self._queries: dict[str, "_Query"] = {}                  # inner label -> collector
        self._inner_batches: dict[str, dict[str, Any]] = {}     # inner batch id -> state
        self._replaying = False
        self.established = asyncio.Event()
        self.closed = asyncio.Event()
        self.close_reason = ""
        self.claims: dict[str, dict] = {}                         # path -> holder info (all links)

    # -- connection lifecycle --

    async def connect(self, *, initial_state: str = "idle", timeout: float = 30.0) -> None:
        token = self.s.read_token()
        try:
            self._reader, self._writer = await asyncio.wait_for(
                asyncio.open_connection(self.s.host, self.s.port, ssl=self.s.ssl_context(),
                                        server_hostname=self.s.host if self.s.use_tls else None), timeout)
        except Exception as e:  # noqa: BLE001
            raise LinkError(f"connect {self.s.host}:{self.s.port} failed: {e}") from e
        nonce = secrets.token_hex(32)
        await self._write(build("CHALLENGE", nonce))
        proof_line = await self._read_line(timeout)
        if proof_line.command == "ERROR":
            raise LinkError(f"server error: {' '.join(proof_line.params)}")
        if proof_line.command != "PROOF":
            raise LinkError(f"expected PROOF, got {proof_line.command}")
        if expected_proof(token, nonce, self.s.server_name) not in proof_line.params:
            await self._hard_close()
            raise LinkError("server identity check failed — refusing to send the link token", retryable=True)
        await self._write(build("LINK", str(PROTOCOL_VERSION), self.link_name, token))
        linked = await self._read_line(timeout)
        if linked.command == "ERROR":
            reason = " ".join(linked.params)
            raise LinkError(f"link refused: {reason}", retryable=reason not in ("bad credential", "invalid link name"))
        if linked.command != "LINKED":
            raise LinkError(f"expected LINKED, got {linked.command}")
        await self._write("BURST")
        await self._write(build("INTRODUCE", self.s.account, self.s.nick, "*", "operator", "agent",
                                self.s.project, self.s.realname))
        await self._write(build("STATE", self.s.account, initial_state))
        await self._write("ENDBURST")
        self._recv_task = asyncio.create_task(self._recv_loop(), name=f"agent-comms-recv-{self.link_name}")
        self._ka_task = asyncio.create_task(self._keepalive(), name=f"agent-comms-ka-{self.link_name}")
        try:
            await asyncio.wait_for(self.established.wait(), timeout)
        except asyncio.TimeoutError as e:
            await self.close()
            raise LinkError("server burst did not finish") from e

    async def close(self, reason: str = "closed") -> None:
        for t in (self._ka_task, self._recv_task):
            if t and t is not asyncio.current_task():
                t.cancel()
                with contextlib.suppress(BaseException):
                    await t
        await self._hard_close()
        self.close_reason = self.close_reason or reason
        self.closed.set()
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_exception(LinkError("link closed"))
        for q in list(self._queries.values()):
            q.finish()

    async def _hard_close(self) -> None:
        if self._writer and not self._writer.is_closing():
            with contextlib.suppress(Exception):
                self._writer.close()
                await asyncio.wait_for(self._writer.wait_closed(), 3)

    @property
    def is_open(self) -> bool:
        return bool(self._writer) and not self._writer.is_closing() and not self.closed.is_set()

    # -- I/O --

    async def _write(self, line: str) -> None:
        if not self._writer or self._writer.is_closing():
            raise LinkError("not connected")
        self._writer.write(line.encode("utf-8") + b"\r\n")
        await self._writer.drain()

    async def _read_line(self, timeout: float) -> Line:
        assert self._reader
        raw = await asyncio.wait_for(self._reader.readline(), timeout)
        if not raw:
            raise LinkError("connection closed by server")
        return parse(raw.decode("utf-8", errors="replace"))

    async def _keepalive(self) -> None:
        while True:
            await asyncio.sleep(45)
            with contextlib.suppress(Exception):
                await self._write(build("PING", f"ka{next(self._labels)}"))

    async def _recv_loop(self) -> None:
        try:
            while self._reader and not self._reader.at_eof():
                raw = await self._reader.readline()
                if not raw:
                    break
                try:
                    await self._handle(parse(raw.decode("utf-8", errors="replace")))
                except Exception:  # noqa: BLE001
                    logger.exception("agent-comms: error handling a server line")
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            logger.warning("agent-comms: receive loop ended: %s", e)
        finally:
            self.close_reason = self.close_reason or "connection lost"
            self.closed.set()
            for fut in list(self._pending.values()):
                if not fut.done():
                    fut.set_exception(LinkError("link closed"))

    # -- dispatch --

    async def _handle(self, ln: Line) -> None:
        cmd = ln.command
        if cmd == "PING":
            await self._write(build("PONG", ln.params[0] if ln.params else ""))
        elif cmd == "ENDBURST":
            self.established.set()
        elif cmd == "BATCH" and ln.params:
            if ln.params[0].startswith("+") and len(ln.params) > 1 and ln.params[1] == "agent-comms.local/replay":
                self._replaying = True
            elif ln.params[0].startswith("-"):
                self._replaying = False
        elif cmd == "INTRODUCED" and len(ln.params) >= 2 and ln.params[0] == self.s.account:
            self.nick = ln.params[1]
        elif cmd == "RENAMED" and len(ln.params) >= 2 and ln.params[0] == self.s.account:
            self.nick = ln.params[1]
        elif cmd in ("SENT", "SENDFAIL", "CLAIMFAIL") or (cmd in ("FAIL", "CLAIMSET", "CLAIMDEL") and ln.tag("label")):
            if cmd == "CLAIMSET" and len(ln.params) >= 5:
                self.claims[ln.params[4]] = {"holder": ln.params[0], "nick": ln.params[1],
                                             "since": int(ln.params[2]), "deadline": int(ln.params[3])}
            elif cmd == "CLAIMDEL" and ln.params:
                self.claims.pop(ln.params[-1], None)
            fut = self._pending.pop(ln.tag("label") or "", None)
            if fut and not fut.done():
                fut.set_result(ln)
        elif cmd == "CLAIMSET" and len(ln.params) >= 5:
            self.claims[ln.params[4]] = {"holder": ln.params[0], "nick": ln.params[1],
                                         "since": int(ln.params[2]), "deadline": int(ln.params[3])}
        elif cmd == "CLAIMDEL" and ln.params:
            self.claims.pop(ln.params[-1], None)
        elif cmd == "DELIVER" and len(ln.params) >= 2 and ln.params[0] == self.s.account:
            await self._handle_inner(parse(ln.params[1]))
        elif cmd == "AGENT" and len(ln.params) >= 3:
            req_id, verb, account = ln.params[0], ln.params[1], ln.params[2]
            text = "unknown account"
            if account == self.s.account and self.on_agent:
                with contextlib.suppress(Exception):
                    text = await self.on_agent(req_id, verb, account)
            await self._write(build("AGENTREPLY", req_id, account, sanitize(text).replace("\n", " ")[:390]))
            await self._write(build("AGENTEND", req_id))
        elif cmd == "ERROR":
            self.close_reason = " ".join(ln.params) or "error"
            logger.warning("agent-comms: server closed the link: %s", self.close_reason)
        elif self.on_other:
            await self.on_other(ln)

    async def _handle_inner(self, inner: Line) -> None:
        cmd = inner.command
        # labeled-response query replies
        label = inner.tag("label")
        batch_id = inner.tag("batch")
        if cmd == "BATCH" and inner.params:
            ref = inner.params[0]
            if ref.startswith("+"):
                bid, kind = ref[1:], (inner.params[1] if len(inner.params) > 1 else "")
                if kind == "labeled-response" and label in self._queries:
                    self._inner_batches[bid] = {"kind": "query", "label": label}
                elif kind == "draft/multiline":
                    self._inner_batches[bid] = {"kind": "ml", "head": inner, "lines": [],
                                                "target": inner.params[2] if len(inner.params) > 2 else ""}
                else:
                    self._inner_batches[bid] = {"kind": "other"}
            else:
                st = self._inner_batches.pop(ref[1:], None)
                if st and st["kind"] == "query":
                    q = self._queries.pop(st["label"], None)
                    if q:
                        q.finish()
                elif st and st["kind"] == "ml":
                    head: Line = st["head"]
                    text = ""
                    for ln_, concat in st["lines"]:
                        text += ln_ if (concat or not text) else "\n" + ln_
                    first_cmd = st.get("cmd", "PRIVMSG")
                    await self._emit(Line(first_cmd, [st["target"], text], head.tags, head.source))
            return
        if batch_id and batch_id in self._inner_batches:
            st = self._inner_batches[batch_id]
            if st["kind"] == "query":
                q = self._queries.get(st["label"])
                if q:
                    q.lines.append(inner)
            elif st["kind"] == "ml" and inner.params:
                st["cmd"] = cmd
                st["lines"].append((inner.params[-1], "draft/multiline-concat" in inner.tags))
            return
        if label and label in self._queries:
            q = self._queries.pop(label)
            if cmd != "ACK":
                q.lines.append(inner)
            q.finish()
            return
        if cmd in ("PRIVMSG", "NOTICE"):
            await self._emit(inner)
        else:
            for q in self._queries.values():   # unlabeled numerics during a query (best effort)
                if q.collect_unlabeled:
                    q.lines.append(inner)

    async def _emit(self, inner: Line) -> None:
        if not self.on_deliver or len(inner.params) < 2:
            return
        try:
            hop = int(inner.tag("+agent-comms.local/hop") or 0)
        except ValueError:
            hop = 0
        await self.on_deliver(Delivered(
            command=inner.command, sender_nick=inner.nick, sender_account=inner.tag("account") or "",
            target=inner.params[0], text=inner.params[1], msgid=inner.tag("msgid") or "",
            time=inner.tag("time") or "", role=inner.tag("agent-comms.local/role") or "agent",
            rel=inner.tag("agent-comms.local/rel") or "peer", broadcast=inner.tag("agent-comms.local/broadcast"),
            hop=hop, replayed=self._replaying))

    # -- operations --

    def _label(self) -> str:
        return f"h{next(self._labels)}"

    async def set_state(self, state: str) -> None:
        await self._write(build("STATE", self.s.account, state))

    async def send_message(self, target: str, text: str, *, hop: int = 0, reply_to: str = "",
                           notice: bool = False, timeout: float = 15.0) -> str:
        """Send PRIVMSG/NOTICE (multiline batch when needed). Returns the msgid; raises on failure."""
        text = sanitize(text).strip("\n")
        if not text:
            raise LinkError("empty message", retryable=False)
        if len(text.encode()) > MAX_MESSAGE_BYTES:
            raise LinkError(f"message larger than {MAX_MESSAGE_BYTES} bytes: put it in a file and send the path",
                            retryable=False)
        verb = "NOTICE" if notice else "PRIVMSG"
        tags: dict[str, Optional[str]] = {"+agent-comms.local/hop": str(max(0, hop))}
        if reply_to:
            tags["+draft/reply"] = reply_to
        label = self._label()
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[label] = fut
        lines = text.split("\n")
        if len(lines) == 1:
            await self._write(build("SEND", self.s.account, build(verb, target, lines[0], tags=tags), tags={"label": label}))
        else:
            bid = f"m{next(self._labels)}"
            await self._write(build("SEND", self.s.account, build("BATCH", f"+{bid}", "draft/multiline", target, tags=tags)))
            for ln_ in lines:
                await self._write(build("SEND", self.s.account, build(verb, target, ln_, tags={"batch": bid})))
            await self._write(build("SEND", self.s.account, build("BATCH", f"-{bid}"), tags={"label": label}))
        try:
            res: Line = await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(label, None)
        if res.command == "SENT":
            return res.params[1] if len(res.params) > 1 else ""
        code = res.params[1] if len(res.params) > 1 else res.command
        raise LinkError(f"send failed: {code} {res.params[-1] if res.params else ''}".strip(), retryable=False)

    async def _labeled(self, line_fn: Callable[[str], str], timeout: float) -> Line:
        label = self._label()
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[label] = fut
        try:
            await self._write(line_fn(label))
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(label, None)

    async def claim(self, path: str, timeout: float = 10.0) -> dict:
        """CLAIM a canonical absolute path. Returns {granted, holder, nick, since, deadline}."""
        res = await self._labeled(lambda l: build("CLAIM", self.s.account, path, tags={"label": l}), timeout)
        if res.command == "CLAIMSET" and len(res.params) >= 5:
            return {"granted": res.params[0] == self.s.account, "holder": res.params[0], "nick": res.params[1],
                    "since": int(res.params[2]), "deadline": int(res.params[3]), "path": res.params[4]}
        if res.command == "CLAIMFAIL" and len(res.params) >= 4:
            return {"granted": False, "holder": "", "nick": res.params[1], "since": int(res.params[2]),
                    "deadline": 0, "path": res.params[3]}
        raise LinkError(f"claim failed: {' '.join(res.params[1:])}", retryable=False)

    async def release(self, path: str, timeout: float = 10.0) -> bool:
        res = await self._labeled(lambda l: build("RELEASE", self.s.account, path, tags={"label": l}), timeout)
        if res.command == "CLAIMDEL":
            return True
        if res.command == "FAIL" and len(res.params) > 1 and res.params[1] == "NOT_HELD":
            return False
        raise LinkError(f"release failed: {' '.join(res.params[1:])}", retryable=False)

    async def query(self, inner_command: str, *params: str, timeout: float = 10.0,
                    collect_unlabeled: bool = False) -> list[Line]:
        """Run a query command (LIST, NAMES, WHO, JOIN, PART, CHATHISTORY...) and collect its replies."""
        label = self._label()
        q = _Query(collect_unlabeled)
        self._queries[label] = q
        await self._write(build("SEND", self.s.account, build(inner_command, *params, tags={"label": label})))
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(q.done.wait(), timeout)
        self._queries.pop(label, None)
        return q.lines


class _Query:
    def __init__(self, collect_unlabeled: bool):
        self.lines: list[Line] = []
        self.done = asyncio.Event()
        self.collect_unlabeled = collect_unlabeled

    def finish(self) -> None:
        self.done.set()


def mentions(text: str, nick: str) -> bool:
    """True when ``nick`` appears as a whole word (IRC nick chars delimit words)."""
    pat = r"(?<![A-Za-z0-9_\-\[\]\\`^{}|])" + re.escape(nick) + r"(?![A-Za-z0-9_\-\[\]\\`^{}|])"
    return re.search(pat, text, re.IGNORECASE) is not None
