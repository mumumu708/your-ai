#!/usr/bin/env bash
# migrate-user-space.sh
# Migrates user-space/ from inside the project to an external directory.
# Usage: ./scripts/migrate-user-space.sh [TARGET_DIR]
# Default target: /data/your-ai-users

set -euo pipefail

SOURCE="./user-space"
TARGET="${1:-/data/your-ai-users}"

if [ ! -d "$SOURCE" ]; then
  echo "No user-space/ directory found in project root. Nothing to migrate."
  exit 0
fi

if [ -d "$TARGET" ] && [ "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  echo "ERROR: Target directory $TARGET already exists and is not empty."
  echo "Please back up and remove it first, or choose a different target."
  exit 1
fi

echo "Migrating user-space/ -> $TARGET"

mkdir -p "$(dirname "$TARGET")"
cp -rp "$SOURCE" "$TARGET"

# Verify copy
SOURCE_COUNT=$(find "$SOURCE" -type f | wc -l | tr -d ' ')
TARGET_COUNT=$(find "$TARGET" -type f | wc -l | tr -d ' ')

if [ "$SOURCE_COUNT" != "$TARGET_COUNT" ]; then
  echo "ERROR: File count mismatch (source=$SOURCE_COUNT, target=$TARGET_COUNT). Aborting."
  echo "Target directory left in place for inspection."
  exit 1
fi

echo "Verified: $TARGET_COUNT files migrated."
echo ""
echo "Next steps:"
echo "  1. Set USER_SPACE_ROOT=$TARGET in your .env"
echo "  2. Restart the service"
echo "  3. Verify everything works"
echo "  4. Remove the old user-space/: rm -rf ./user-space"
