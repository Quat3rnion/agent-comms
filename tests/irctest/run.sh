#!/usr/bin/env bash
# Run the irctest protocol-compliance suite against the agent-comms server.
#
# Usage: tests/irctest/run.sh [extra pytest arguments...]
# The exit code is the exit code of pytest.
#
# Environment variables:
#   IRCTEST_DIR     Where to clone irctest. Default: <repo>/target/irctest
#   IRCTEST_JOBS    Number of parallel pytest workers (needs pytest-xdist). Default: 1
#   AGENT_COMMS_BIN Server binary. Default: <repo>/target/debug/agent-comms
#   SKIP_BUILD=1    Do not run "cargo build".
set -euo pipefail

# ---------------------------------------------------------------------------
# Tuning knobs. Edit these to change which tests run.
# ---------------------------------------------------------------------------

# irctest commit (main branch, 2026-08-30). Change it only after you re-check
# the controller against irctest/basecontrollers.py at the new commit.
IRCTEST_REPO="https://github.com/progval/irctest.git"
IRCTEST_COMMIT="3989a9c2492c920b229d99ec66c31445c9860166"

# Test files and directories to run (relative to the irctest checkout).
SELECT_PATHS=(
  # RFC 1459 / RFC 2812 core
  irctest/server_tests/connection_registration.py
  irctest/server_tests/join.py
  irctest/server_tests/part.py
  irctest/server_tests/topic.py
  irctest/server_tests/names.py
  irctest/server_tests/list.py
  irctest/server_tests/kick.py
  irctest/server_tests/channel.py
  irctest/server_tests/chmodes
  irctest/server_tests/messages.py
  irctest/server_tests/away.py
  irctest/server_tests/who.py
  irctest/server_tests/whois.py
  irctest/server_tests/pingpong.py
  irctest/server_tests/quit.py
  irctest/server_tests/isupport.py
  # IRCv3
  irctest/server_tests/cap.py
  irctest/server_tests/sasl.py
  irctest/server_tests/account_tag.py
  irctest/server_tests/away_notify.py
  irctest/server_tests/echo_message.py
  irctest/server_tests/message_tags.py
  irctest/server_tests/labeled_responses.py
  irctest/server_tests/multiline.py
  irctest/server_tests/chathistory.py
  irctest/server_tests/read_marker.py
)

# pytest marker expression (-m). Tests for unsupported features are excluded.
MARKER_EXPR="not Ergo and not Sable and not implementation-specific \
and not deprecated and not strict and not services \
and not react_tag and not private_chathistory \
and not extended-join and not multi-prefix and not setname \
and not account-notify and not extended-monitor and not metadata-2 \
and not draft/message-redaction and not sts \
and not MONITOR and not STATUSMSG and not WHOX"

# pytest keyword expression (-k). Leave empty to disable.
# Example: K_EXPR="not test_whowas"
K_EXPR=""

# Tests to deselect (pytest node id prefixes, passed as --deselect).
DESELECT=(
  # irctest/server_tests/list.py::ListTestCase::test_list_elist_c
)

# ---------------------------------------------------------------------------

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/tests/irctest"
IRCTEST_DIR="${IRCTEST_DIR:-$ROOT/target/irctest}"
IRCTEST_JOBS="${IRCTEST_JOBS:-1}"
export AGENT_COMMS_BIN="${AGENT_COMMS_BIN:-$ROOT/target/debug/agent-comms}"

# 1. Get irctest at the pinned commit.
if [ ! -d "$IRCTEST_DIR/.git" ]; then
  mkdir -p "$(dirname "$IRCTEST_DIR")"
  git clone "$IRCTEST_REPO" "$IRCTEST_DIR"
fi
if [ "$(git -C "$IRCTEST_DIR" rev-parse HEAD)" != "$IRCTEST_COMMIT" ]; then
  git -C "$IRCTEST_DIR" fetch origin "$IRCTEST_COMMIT" \
    || git -C "$IRCTEST_DIR" fetch origin
  git -C "$IRCTEST_DIR" checkout --quiet "$IRCTEST_COMMIT"
fi

# 2. Python virtual environment.
VENV="$IRCTEST_DIR/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet \
  -r "$IRCTEST_DIR/requirements.txt" pytest pytest-xdist argon2-cffi

# 3. Install the controller.
cp "$HERE/agent_comms_controller.py" "$IRCTEST_DIR/irctest/controllers/agent_comms.py"

# 4. Build the server.
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  (cd "$ROOT" && cargo build -p agent-comms)
fi
if [ ! -x "$AGENT_COMMS_BIN" ]; then
  echo "server binary not found: $AGENT_COMMS_BIN" >&2
  exit 2
fi

# 5. Run pytest.
ARGS=(--controller irctest.controllers.agent_comms -m "$MARKER_EXPR")
if [ -n "$K_EXPR" ]; then
  ARGS+=(-k "$K_EXPR")
fi
for d in "${DESELECT[@]:-}"; do
  if [ -n "$d" ]; then
    ARGS+=(--deselect "$d")
  fi
done
if [ "$IRCTEST_JOBS" != "1" ]; then
  ARGS+=(-n "$IRCTEST_JOBS")
fi

cd "$IRCTEST_DIR"
exec "$VENV/bin/python" -m pytest "${ARGS[@]}" "$@" "${SELECT_PATHS[@]}"
