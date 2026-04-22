---
name: rebuild-everything
description: Full rebuild and restart of NanoClaw — dependencies, TypeScript, container image, and service. Use after code changes, cherry-picks, or upstream updates.
---

# Rebuild Everything

Performs a full rebuild so all code changes are reflected in running containers and the service.

## Modes

- **Dev mode** (`/rebuild-everything dev` or `development` or `develop`): Run steps 1–5 only. Skips service restart and verification. Use during active development when the service is not running.
- **Full mode** (default, no argument): Run all steps 1–7. Restarts the service and verifies it's running.

## Steps

Run each step sequentially. Stop on any error and report it.

### 1. Install dependencies

```bash
npm install
```

### 2. Build TypeScript

```bash
npm run build
```

### 3. Run tests

```bash
npm test 2>&1 | tail -20
```

If tests fail, show the failures but continue — the user may want to rebuild anyway.

### 4. Rebuild container image

```bash
./container/build.sh
```

This rebuilds the agent container with the latest agent-runner source, skills, and dependencies.

### 5. Clear stale container config cache

Per-group agent-runner source is cached in `data/claude-container-config/`. Clear the cached copies so containers pick up the fresh source on next spawn:

```bash
find data/claude-container-config -name 'agent-runner-src' -type d -exec rm -rf {} + 2>/dev/null || true
```

### 6. Restart NanoClaw service

```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw # restart

# Linux (systemd) — use if launchd is not available
# systemctl --user restart nanoclaw
```

### 7. Verify service is running

Wait 3 seconds, then check:

```bash
sleep 3
launchctl list | grep nanoclaw
# Linux: systemctl --user status nanoclaw
```

Report the service status to the user.

## When to use

- After cherry-picking or merging upstream changes
- After modifying `src/`, `container/`, or `package.json`
- After changing container skills (`container/skills/`)
- After modifying agent-runner (`container/agent-runner/`)
- When something feels stale or broken
