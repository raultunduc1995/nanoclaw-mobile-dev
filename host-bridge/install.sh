#!/bin/bash
# NanoClaw Host Bridge Installer — run on each Mac you want to control.
# Usage: bash install.sh <bridge-secret>
#
# What it does:
#   1. Copies bridge.js to ~/Library/NanoClaw/host-bridge/
#   2. Creates a launchd plist that runs the bridge on login
#   3. Starts the bridge immediately
set -e
SECRET="${1}"
BRIDGE_PORT="${BRIDGE_PORT:-3737}"
if [ -z "$SECRET" ]; then
  echo "Usage: bash install.sh <bridge-secret>"
  echo ""
  echo "The bridge-secret must match BRIDGE_SECRET in your NanoClaw .env"
  echo "Example: bash install.sh mysecretkey123"
  exit 1
fi
INSTALL_DIR="$HOME/Library/NanoClaw/host-bridge"
PLIST_PATH="$HOME/Library/LaunchAgents/com.nanoclaw.bridge.plist"
NODE_BIN="$(which node)"
if [ -z "$NODE_BIN" ]; then echo "Error: node not found."; exit 1; fi
echo "Installing NanoClaw host bridge..."
echo "  Install dir: $INSTALL_DIR"
echo "  Port: $BRIDGE_PORT"
echo "  Node: $NODE_BIN"
mkdir -p "$INSTALL_DIR"
cp "$(dirname "$0")/bridge.js" "$INSTALL_DIR/bridge.js"
# Write launchd plist
cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.nanoclaw.bridge</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$INSTALL_DIR/bridge.js</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>BRIDGE_SECRET</key><string>$SECRET</string>
        <key>BRIDGE_PORT</key><string>$BRIDGE_PORT</string>
        <key>HOME</key><string>$HOME</string>
        <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$HOME/Library/NanoClaw/host-bridge/bridge.log</string>
    <key>StandardErrorPath</key><string>$HOME/Library/NanoClaw/host-bridge/bridge.error.log</string>
</dict>
</plist>
EOF
chmod 644 "$PLIST_PATH"
# Unload if already running
launchctl bootout "gui/$(id -u)/com.nanoclaw.bridge" 2>/dev/null || true
# Load and start
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
sleep 1
echo ""
# Verify it started
if launchctl list | grep -q "com.nanoclaw.bridge"; then
  echo ""
  echo "✓ Host bridge running on port $BRIDGE_PORT"
  echo "Find your LAN IP: ipconfig getifaddr en0"
else
  echo "Warning: check $HOME/Library/NanoClaw/host-bridge/bridge.error.log"
fi
