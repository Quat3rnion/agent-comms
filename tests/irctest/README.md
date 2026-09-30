# irctest harness

This directory runs the [irctest](https://github.com/progval/irctest) suite against the agent-comms server.
irctest checks IRC protocol compliance.

## Files

- `run.sh` - clones irctest, sets up Python, builds the server, and runs pytest.
- `agent_comms_controller.py` - the irctest controller for agent-comms.
  `run.sh` copies it to `irctest/controllers/agent_comms.py`.

## Requirements

- Rust toolchain (`cargo`).
- `python3` with the `venv` module.
- `git`.
- Network access to clone irctest and install Python packages.

## Run the tests

Run this command from the repository root:

```sh
tests/irctest/run.sh
```

The script does these steps:

1. It clones irctest to `target/irctest`. It uses a pinned commit.
2. It creates a virtual environment in `target/irctest/.venv`.
3. It installs the irctest requirements and `argon2-cffi`.
4. It builds the server with `cargo build -p agent-comms`.
5. It runs pytest with the agent-comms controller.

The exit code of the script is the exit code of pytest.

## Options

Set these environment variables to change the run:

| Variable | Meaning | Default |
| --- | --- | --- |
| `IRCTEST_DIR` | Directory of the irctest clone | `target/irctest` |
| `IRCTEST_JOBS` | Number of parallel pytest workers | `1` |
| `AGENT_COMMS_BIN` | Path of the server binary | `target/debug/agent-comms` |
| `SKIP_BUILD` | Set to `1` to skip `cargo build` | unset |

Add pytest arguments after the script name. For example, run one test:

```sh
tests/irctest/run.sh -k test_nick_collision -x
```

## Select tests

The variables at the top of `run.sh` control the test selection:

- `SELECT_PATHS` - the irctest files to run.
- `MARKER_EXPR` - the pytest marker expression. It excludes unsupported features.
- `K_EXPR` - an optional pytest keyword expression.
- `DESELECT` - a list of single tests to skip.

To skip a failing test that the server does not need to pass, add its node ID to `DESELECT`.

## Supported features

The controller declares these capabilities:
`message-tags`, `server-time`, `account-tag`, `away-notify`, `echo-message`, `batch`, `labeled-response`, `draft/multiline`, `draft/read-marker`.
The only SASL mechanism is `PLAIN`.

The controller does not support these features. Tests for them are skipped:

- TLS, WebSocket, and server passwords.
- Services (NickServ).
- SASL accounts other than `operator`.
- `faketime`.

## Update irctest

1. Choose a new commit on the irctest main branch.
2. Read `irctest/basecontrollers.py` at that commit. Check that the `run()` signature did not change.
3. Change `IRCTEST_COMMIT` in `run.sh`.
4. Run the suite again.

## Debug

Set `IRCTEST_DEBUG_LOGS=1` to print the server output.
