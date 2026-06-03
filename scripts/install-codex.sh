#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec bash "$ROOT_DIR/Claude-to-IM-skill/scripts/install-codex.sh" "$@"
