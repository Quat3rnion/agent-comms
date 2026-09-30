"""irctest server controller for the agent-comms IRC server.

`run.sh` copies this file to `irctest/controllers/agent_comms.py` in the irctest
checkout. It is written for the irctest API at the commit pinned in `run.sh`.

Environment variables:
    AGENT_COMMS_BIN   Path of the server binary.
                      Default: `<repo>/target/debug/agent-comms`.
"""

import json
import os
from pathlib import Path
import subprocess
from typing import Any, Optional, Set, Type

from irctest.basecontrollers import BaseServerController, DirectoryBasedController
from irctest.runner import NotImplementedByController
from irctest.specifications import Capabilities

# In the repository, this file is tests/irctest/agent_comms_controller.py, so the
# root is parents[2]. After the copy into irctest, only AGENT_COMMS_BIN is reliable;
# run.sh always sets it.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_BIN = _REPO_ROOT / "target" / "debug" / "agent-comms"

# The only SASL account is the operator account. Its name is fixed.
OPERATOR_ACCOUNT = "operator"

CONFIG_TEMPLATE = """\
server_name = {server_name}
bind = {bind}
data_dir = {data_dir}
secrets_path = {secrets_path}
require_sasl = false

[limits]
# Do not throttle the test clients.
flood_burst = 100000
flood_rate_per_sec = 100000
nick_max_len = 32
"""


def _toml_str(value: Any) -> str:
    """Return a TOML basic string. JSON strings are valid TOML basic strings."""
    return json.dumps(str(value))


def _binary() -> str:
    return os.environ.get("AGENT_COMMS_BIN") or str(_DEFAULT_BIN)


class AgentCommsController(BaseServerController, DirectoryBasedController):
    software_name = "agent-comms"
    # Only SASL PLAIN is supported.
    supported_sasl_mechanisms: Set[str] = {"PLAIN"}
    supports_sts = False
    # No mute extban.
    extban_mute_char = None

    capabilities = frozenset(
        (
            Capabilities.ACCOUNT_TAG,
            Capabilities.AWAY_NOTIFY,
            Capabilities.BATCH,
            Capabilities.ECHO_MESSAGE,
            Capabilities.LABELED_RESPONSE,
            Capabilities.MESSAGE_TAGS,
            Capabilities.MULTILINE,
            Capabilities.READ_MARKER,
            Capabilities.SERVER_TIME,
        )
    )

    _port_wait_interval = 0.05

    def create_config(self) -> None:
        super().create_config()
        with self.open_file("config.toml"):
            pass

    # -- process handling ---------------------------------------------------

    def _start(self) -> None:
        assert self.directory
        self.proc = self.execute(
            [_binary(), "serve", "--config-dir", str(self.directory)],
            proc_name="agent-comms",
        )

    def restart(self) -> None:
        """Restart the server. It loads `secrets.toml` at startup."""
        self.kill_proc()
        self.port_open = False
        self._start()
        self.wait_for_port()

    def run(
        self,
        hostname: str,
        port: int,
        *,
        password: Optional[str],
        ssl: bool,
        run_services: bool,
        faketime: Optional[str],
        config: Optional[Any] = None,
        websocket_hostname: Optional[str] = None,
        websocket_port: Optional[int] = None,
    ) -> None:
        if ssl:
            raise NotImplementedByController("TLS")
        if run_services:
            raise NotImplementedByController("services")
        if password is not None:
            raise NotImplementedByController("server password")
        if websocket_hostname is not None or websocket_port is not None:
            raise NotImplementedByController("WebSocket")
        if config is not None:
            raise NotImplementedByController("custom server configuration")
        # `faketime` is not supported. `faketime_enabled` stays False,
        # so tests that need it skip themselves.
        assert self.proc is None

        self.port = port
        self.hostname = hostname
        self.create_config()
        assert self.directory

        data_dir = self.directory / "data"
        data_dir.mkdir(parents=True, exist_ok=True)
        self._secrets_path = self.directory / "secrets.toml"
        self._write_secrets(None)

        with self.open_file("config.toml", "w") as fd:
            fd.write(
                CONFIG_TEMPLATE.format(
                    server_name=_toml_str("My.Little.Server"),
                    # irctest passes an empty hostname. Always bind to loopback.
                    bind=_toml_str(f"127.0.0.1:{port}"),
                    data_dir=_toml_str(data_dir),
                    secrets_path=_toml_str(self._secrets_path),
                )
            )

        self._start()

    # -- accounts -----------------------------------------------------------

    def _write_secrets(self, password_hash: Optional[str]) -> None:
        """Write `secrets.toml` with mode 0600."""
        lines = ["links = []", ""]
        if password_hash is not None:
            lines += [
                "[operator]",
                f"account = {_toml_str(OPERATOR_ACCOUNT)}",
                f"password_hash = {_toml_str(password_hash)}",
                "",
            ]
        fd = os.open(self._secrets_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write("\n".join(lines))
        os.chmod(self._secrets_path, 0o600)

    def _hash_password(self, password: str) -> Optional[str]:
        """Return an argon2id PHC string, or None if argon2-cffi is missing."""
        try:
            from argon2 import PasswordHasher
        except ImportError:
            return None
        return PasswordHasher().hash(password)

    def registerUser(
        self,
        case: Any,
        username: str,
        password: Optional[str] = None,
    ) -> None:
        if username != OPERATOR_ACCOUNT:
            raise NotImplementedByController(
                f"account {username!r}: only the {OPERATOR_ACCOUNT!r} account exists"
            )
        if not password:
            raise NotImplementedByController("account without password")
        assert self.directory

        password_hash = self._hash_password(password)
        if password_hash is not None:
            self._write_secrets(password_hash)
        else:
            # Fall back to the server CLI. It writes the hash to `secrets.toml`.
            subprocess.check_call(
                [
                    _binary(),
                    "--config-dir",
                    str(self.directory),
                    "operator-password",
                    "--password",
                    password,
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        # The server reads secrets at startup, so restart it.
        self.restart()

    def wait_for_services(self) -> None:
        # No services exist.
        pass


def get_irctest_controller_class() -> Type[AgentCommsController]:
    return AgentCommsController
