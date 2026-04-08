#!/bin/bash
set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
KEY_PATHS="src/|container/|groups/|scripts/|setup/|launchd/|host-bridge/|store/"

remind() {
  echo "REMINDER: Structural change detected. Check if CLAUDE.md needs updating (Key Files table, architecture references)."
}

case "$TOOL_NAME" in
  Write)
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
    if echo "$FILE_PATH" | grep -qE "$KEY_PATHS"; then
      remind
    fi
    ;;
  Bash)
    COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
    if echo "$COMMAND" | grep -qE '(git mv|mv\s|rm\s|rm -|rmdir|mkdir)' && \
       echo "$COMMAND" | grep -qE "$KEY_PATHS"; then
      remind
    fi
    ;;
esac

exit 0
