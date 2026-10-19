#!/usr/bin/env bash
# Build and package the agent-comms release artifacts in dist/.
# This script does not tag and does not publish.
#
# Environment:
#   TARGETS  space-separated Rust targets (default: both macOS targets)
#   DIST     output directory (default: <repo>/dist)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGETS="${TARGETS:-aarch64-apple-darwin x86_64-apple-darwin}"
DIST="${DIST:-$ROOT/dist}"
BIN=agent-comms

die() {
  echo "error: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 not found in PATH"
}

need cargo
need tar
need shasum

VERSION="$(sed -n '/^\[workspace\.package\]/,/^\[/p' Cargo.toml | grep -m1 '^version' | cut -d'"' -f2)"
[ -n "$VERSION" ] || die "cannot read the workspace version from Cargo.toml"

PLUGIN_VERSION="$(grep -m1 '"version"' plugin/package.json | cut -d'"' -f4)"
if [ "$PLUGIN_VERSION" != "$VERSION" ]; then
  die "version mismatch: Cargo.toml has $VERSION, plugin/package.json has $PLUGIN_VERSION"
fi

echo "==> agent-comms $VERSION"
rm -rf "$DIST"
mkdir -p "$DIST"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# package <name> <binary path>
package() {
  local name="$1" bin_path="$2"
  local dir="$STAGE/$name"
  mkdir -p "$dir/docs"
  cp "$bin_path" "$dir/$BIN"
  chmod 755 "$dir/$BIN"
  cp LICENSE README.md "$dir/"
  cp docs/operator-guide.md "$dir/docs/"
  tar -C "$STAGE" -czf "$DIST/$name.tar.gz" "$name"
  echo "    wrote dist/$name.tar.gz"
}

for target in $TARGETS; do
  echo "==> build $target"
  if command -v rustup >/dev/null 2>&1; then
    if ! rustup target list --installed | grep -qx "$target"; then
      rustup target add "$target"
    fi
  fi
  cargo build --release --locked -p agent-comms --target "$target"
  bin_path="target/$target/release/$BIN"
  [ -x "$bin_path" ] || die "binary not found: $bin_path"
  package "$BIN-$VERSION-$target" "$bin_path"
done

arm="target/aarch64-apple-darwin/release/$BIN"
x86="target/x86_64-apple-darwin/release/$BIN"
if [[ " $TARGETS " == *" aarch64-apple-darwin "* && " $TARGETS " == *" x86_64-apple-darwin "* ]]; then
  need lipo
  echo "==> universal binary"
  universal="$STAGE/$BIN-universal"
  lipo -create -output "$universal" "$arm" "$x86"
  lipo -info "$universal"
  package "$BIN-$VERSION-universal-apple-darwin" "$universal"
fi

echo "==> plugin package"
if command -v bun >/dev/null 2>&1; then
  (cd plugin && bun pm pack --destination "$DIST")
elif command -v npm >/dev/null 2>&1; then
  (cd plugin && npm pack --pack-destination "$DIST")
else
  die "bun or npm is necessary to pack the plugin"
fi

echo "==> hermes plugin"
HERMES_VERSION="$(grep -m1 '^version:' hermes/plugin.yaml | awk '{print $2}')"
[ "$HERMES_VERSION" = "$VERSION" ] || die "version mismatch: Cargo.toml has $VERSION, hermes/plugin.yaml has $HERMES_VERSION"
tar -C "$ROOT" --exclude=__pycache__ -s ",^hermes,agent-comms," -czf "$DIST/hermes-agent-comms-$VERSION.tar.gz" hermes 2>/dev/null ||
  tar -C "$ROOT" --exclude=__pycache__ --transform "s,^hermes,agent-comms," -czf "$DIST/hermes-agent-comms-$VERSION.tar.gz" hermes
echo "    wrote dist/hermes-agent-comms-$VERSION.tar.gz"

echo "==> checksums"
(
  cd "$DIST"
  shopt -s nullglob
  files=(*.tar.gz *.tgz)
  [ "${#files[@]}" -gt 0 ] || die "no artifacts in $DIST"
  shasum -a 256 "${files[@]}" >SHA256SUMS
  cat SHA256SUMS
)

cat <<EOF

Release artifacts for $VERSION are in $DIST.

Next steps (this script did not do them):
  1. Make sure that CHANGELOG.md has a section for $VERSION.
  2. Tag the release:
       git tag -a v$VERSION -m "release v$VERSION"
       git push origin v$VERSION
  3. Publish the plugin:
       cd plugin && npm publish --access public
     (or: npm publish $DIST/opencode-agent-comms-$VERSION.tgz --access public)
  4. Attach the files in $DIST to the release page.
EOF
