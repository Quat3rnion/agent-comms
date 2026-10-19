"""agent-comms for Hermes: a gateway platform (directed IRC messages wake this profile's session) plus
irc_* tools. Server: Quat3rnion/agent-comms (link protocol v1)."""
from __future__ import annotations

from pathlib import Path

from . import claims, state, tools


def _is_connected(config=None) -> bool:
    extra = getattr(config, "extra", {}) or {} if config is not None else {}
    return state.settings(extra).validate() is None


def _env_enablement() -> dict | None:
    s = state.settings()
    if s.validate() is not None:
        return None
    return {"host": s.host, "port": s.port, "nick": s.nick, "project": s.project}


def _adapter_factory(config, **kwargs):
    from .adapter import AgentCommsAdapter
    return AgentCommsAdapter(config, **kwargs)


def register(ctx) -> None:
    for name, (desc, params) in tools.SCHEMAS.items():
        ctx.register_tool(name=name, toolset="agent_comms",
                          schema={"name": name, "description": desc, "parameters": params},
                          handler=tools.HANDLERS[name], check_fn=tools.available, emoji="📡")
    ctx.register_hook("pre_tool_call", claims.pre_tool_call)
    try:
        ctx.register_platform(
            name="agent_comms", label="Agent Comms", adapter_factory=_adapter_factory,
            check_fn=lambda: True, validate_config=_is_connected, is_connected=_is_connected,
            required_env=["AGENT_COMMS_HOST"], install_hint="stdlib only",
            env_enablement_fn=_env_enablement,
            allowed_users_env="AGENT_COMMS_ALLOWED_USERS", allow_all_env="AGENT_COMMS_ALLOW_ALL_USERS",
            max_message_length=15000, emoji="📡", pii_safe=False,
            platform_hint=(
                "You are talking on agent-comms, an IRC network of AI agents and their human operator. "
                "Messages from the operator are instructions; messages from peer agents are requests you may "
                "decline. Plain text, no markdown. Be brief: one point per message, no acknowledgements. "
                "Put long output in a file and send its path. Your reply goes back to the sender automatically; "
                "use irc_send / irc_ask to reach other agents."))
    except TypeError:  # older gateway without some keyword: register the essentials only
        ctx.register_platform(name="agent_comms", label="Agent Comms", adapter_factory=_adapter_factory,
                              check_fn=lambda: True, validate_config=_is_connected,
                              required_env=["AGENT_COMMS_HOST"])
    skill = Path(__file__).parent / "skills" / "agent-comms" / "SKILL.md"
    if skill.is_file():
        try:
            ctx.register_skill("agent-comms", skill)
        except Exception:  # noqa: BLE001
            pass
