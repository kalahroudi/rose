#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Run the TenantDeletion TLC check and draw a statechart via pstack /statechart.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SPEC="$ROOT/formal/tenant-deletion/TenantDeletion.tla"
CFG="$ROOT/formal/tenant-deletion/TenantDeletion.cfg"
VIEW="$ROOT/formal/tenant-deletion/view.mjs"
JAR="$ROOT/formal/tools/tla2tools.jar"
OUT="${1:-$ROOT/formal/tenant-deletion/out}"

STATECHART="$(ls -d "$HOME"/.cursor/plugins/cache/cursor-public/pstack/*/skills/statechart/scripts/statechart.ts 2>/dev/null | sort | tail -1 || true)"
if [[ -z "${STATECHART}" ]]; then
  echo "Cannot find the pstack statechart skill. Install the pstack Cursor plugin, or run /statechart on $SPEC yourself." >&2
  exit 2
fi

TLA_URL="https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar"
TLA_SHA="936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
if [[ ! -f "$JAR" ]]; then
  mkdir -p "$(dirname "$JAR")"
  echo "Downloading tla2tools 1.7.4 → $JAR"
  curl -fsSL -o "$JAR" "$TLA_URL"
fi
GOT="$(shasum -a 256 "$JAR" | awk '{print $1}')"
if [[ "$GOT" != "$TLA_SHA" ]]; then
  echo "Checksum mismatch for $JAR (got $GOT, want $TLA_SHA)." >&2
  exit 2
fi

# Prefer the mise Temurin JDK the statechart skill pins; fall back to JAVA_HOME / java.
if [[ -z "${JAVA:-}" ]]; then
  if command -v mise >/dev/null 2>&1; then
    JAVA="$(mise env -s bash java@temurin-25 2>/dev/null | sed -n 's/^export JAVA_HOME=\(.*\)/\1\/bin\/java/p' | tr -d '"' || true)"
  fi
  if [[ -z "${JAVA:-}" || ! -x "${JAVA:-}" ]]; then
    CANDIDATE="$HOME/.local/share/mise/installs/java/temurin-25.0.5+8.0.LTS/Contents/Home/bin/java"
    if [[ -x "$CANDIDATE" ]]; then JAVA="$CANDIDATE"; fi
  fi
  if [[ -z "${JAVA:-}" ]]; then JAVA="$(command -v java || true)"; fi
fi
if [[ -z "${JAVA:-}" ]]; then
  echo "Need a Java 11+ binary. Install with: mise install java@temurin-25" >&2
  exit 2
fi

rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"

export TLA2TOOLS="$JAR"
export JAVA
exec node "$STATECHART" "$SPEC" --config "$CFG" --view "$VIEW" --out "$OUT"
