#!/usr/bin/env bash
set -euo pipefail

# Install Remote Agent Control skill for Claude Code.
# Usage: bash scripts/install-claude.sh [--link]
#   --link  Create symlinks instead of copying (for development)

SKILL_NAME="remote-agent-control"
CORE_DIR_NAME="Claude-to-IM"
CLAUDE_SKILLS_DIR="$HOME/.claude/skills"
TARGET_DIR="$CLAUDE_SKILLS_DIR/$SKILL_NAME"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/Claude-to-IM-skill"
CORE_SOURCE_DIR="$ROOT_DIR/$CORE_DIR_NAME"
CORE_TARGET_DIR="$CLAUDE_SKILLS_DIR/$CORE_DIR_NAME"

echo "Installing Remote Agent Control skill for Claude Code..."

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

if [ ! -f "$SOURCE_DIR/SKILL.md" ]; then
  echo "Error: SKILL.md not found in $SOURCE_DIR"
  exit 1
fi

if [ ! -f "$CORE_SOURCE_DIR/package.json" ]; then
  echo "Error: core package not found at $CORE_SOURCE_DIR"
  exit 1
fi

mkdir -p "$CLAUDE_SKILLS_DIR"

# The source workspace still uses a transitional file dependency path:
# remote-agent-control-skill depends on file:../Claude-to-IM.
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

if [ ! -d "$TARGET_DIR/node_modules" ]; then
  echo "Installing dependencies..."
  (cd "$TARGET_DIR" && npm install)
fi

if [ ! -f "$TARGET_DIR/dist/daemon.mjs" ]; then
  echo "Building daemon bundle..."
  (cd "$TARGET_DIR" && npm run build)
fi

echo "Pruning dev dependencies..."
(cd "$TARGET_DIR" && npm prune --production)

echo ""
echo "Done! Start a new Claude Code session and use:"
echo "  /remote-agent-control setup    - configure IM platform credentials"
echo "  /remote-agent-control start    - start the bridge daemon"
echo "  /remote-agent-control doctor   - diagnose issues"
