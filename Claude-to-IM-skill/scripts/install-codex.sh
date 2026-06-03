#!/usr/bin/env bash
set -euo pipefail

# Install Remote Agent Control skill for Codex.
# Usage: bash scripts/install-codex.sh [--link]
#   --link  Create a symlink instead of copying (for development)

SKILL_NAME="remote-agent-control"
CORE_DIR_NAME="Claude-to-IM"
CODEX_SKILLS_DIR="$HOME/.codex/skills"
TARGET_DIR="$CODEX_SKILLS_DIR/$SKILL_NAME"
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CORE_SOURCE_DIR="$(cd "$SOURCE_DIR/../$CORE_DIR_NAME" 2>/dev/null && pwd || true)"
CORE_TARGET_DIR="$CODEX_SKILLS_DIR/$CORE_DIR_NAME"

echo "Installing Remote Agent Control skill for Codex..."

copy_source_dir() {
  local src="$1"
  local dest="$2"
  mkdir -p "$dest"
  (
    cd "$src"
    tar \
      --exclude='./.git' \
      --exclude='./node_modules' \
      --exclude='./dist' \
      --exclude='./*.tgz' \
      -cf - .
  ) | (
    cd "$dest"
    tar -xf -
  )
}

# Check source
if [ ! -f "$SOURCE_DIR/SKILL.md" ]; then
  echo "Error: SKILL.md not found in $SOURCE_DIR"
  exit 1
fi

if [ -z "$CORE_SOURCE_DIR" ] || [ ! -f "$CORE_SOURCE_DIR/package.json" ]; then
  echo "Error: core package not found at $SOURCE_DIR/../$CORE_DIR_NAME"
  echo "This source build expects sibling directories:"
  echo "  $CORE_DIR_NAME/"
  echo "  $(basename "$SOURCE_DIR")/"
  exit 1
fi

# Create skills directory
mkdir -p "$CODEX_SKILLS_DIR"

# Make the core package available next to the installed skill because the
# transitional source workspace depends on it through file:../Claude-to-IM.
if [ ! -e "$CORE_TARGET_DIR" ]; then
  if [ "${1:-}" = "--link" ]; then
    ln -s "$CORE_SOURCE_DIR" "$CORE_TARGET_DIR"
    echo "Symlinked core: $CORE_TARGET_DIR -> $CORE_SOURCE_DIR"
  else
    copy_source_dir "$CORE_SOURCE_DIR" "$CORE_TARGET_DIR"
    echo "Copied core package to dependency path: $CORE_TARGET_DIR"
  fi
fi

echo "Installing core dependencies..."
(cd "$CORE_TARGET_DIR" && npm install)

echo "Building core library..."
(cd "$CORE_TARGET_DIR" && npm run build)

# Check if already installed
if [ -e "$TARGET_DIR" ]; then
  if [ -L "$TARGET_DIR" ]; then
    EXISTING=$(readlink "$TARGET_DIR")
    echo "Already installed as symlink -> $EXISTING"
    echo "To reinstall, remove it first: rm $TARGET_DIR"
    exit 0
  else
    echo "Already installed at $TARGET_DIR"
    echo "To reinstall, remove it first: rm -rf $TARGET_DIR"
    exit 0
  fi
fi

if [ "${1:-}" = "--link" ]; then
  ln -s "$SOURCE_DIR" "$TARGET_DIR"
  echo "Symlinked: $TARGET_DIR -> $SOURCE_DIR"
else
  copy_source_dir "$SOURCE_DIR" "$TARGET_DIR"
  echo "Copied to: $TARGET_DIR"
fi

# Ensure dependencies (need devDependencies for build step)
if [ ! -d "$TARGET_DIR/node_modules" ] || [ ! -d "$TARGET_DIR/node_modules/@openai/codex-sdk" ]; then
  echo "Installing dependencies..."
  (cd "$TARGET_DIR" && npm install)
fi

# Ensure build
if [ ! -f "$TARGET_DIR/dist/daemon.mjs" ]; then
  echo "Building daemon bundle..."
  (cd "$TARGET_DIR" && npm run build)
fi

# Prune devDependencies after build
echo "Pruning dev dependencies..."
(cd "$TARGET_DIR" && npm prune --production)

echo ""
echo "Done! Start a new Codex session and use:"
echo "  remote-agent-control setup    - configure IM platform credentials"
echo "  remote-agent-control start    - start the bridge daemon"
echo "  remote-agent-control doctor   - diagnose issues"
