---
name: setup-telegram
description: Add Telegram as a channel. Can replace WhatsApp entirely or run alongside it. Also configurable as a control-only channel (triggers actions) or passive channel (receives notifications only).
---

# Add Telegram Channel

This skill adds Telegram support to NanoClaw. The channel code is already bundled — this skill enables it via feature flag and walks through interactive setup.

## Phase 1: Pre-flight

### Check current state

Check if Telegram is already configured:

```bash
grep 'ENABLE_TELEGRAM' .env 2>/dev/null && echo "Flag exists" || echo "No flag"
grep 'TELEGRAM_BOT_TOKEN' .env 2>/dev/null && echo "Token exists" || echo "No token"
```

If both exist and service is running, skip to Phase 4 (Registration) or Phase 5 (Verify).

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you have a Telegram bot token, or do you need to create one?

If they have one, collect it now. If not, we'll create one in Phase 3.

## Phase 2: Enable Telegram feature flag

Add `ENABLE_TELEGRAM=true` to `.env` (creates the file if it doesn't exist):

```bash
grep -q '^ENABLE_TELEGRAM=' .env 2>/dev/null && sed -i '' 's/^ENABLE_TELEGRAM=.*/ENABLE_TELEGRAM=true/' .env || echo "ENABLE_TELEGRAM=true" >> .env
```

Verify:

```bash
grep ENABLE_TELEGRAM .env
```

All tests must pass and build must be clean before proceeding.

```bash
npx vitest run src/channels/telegram/index.test.ts
```

## Phase 3: Setup

### Create Telegram Bot (if needed)

If the user doesn't have a bot token, tell them:

> I need you to create a Telegram bot:
>
> 1. Open Telegram and search for `@BotFather`
> 2. Send `/newbot` and follow prompts:
>    - Bot name: Something friendly (e.g., "Nano Assistant")
>    - Bot username: Must end with "bot" (e.g., "nano_ai_bot")
> 3. Copy the bot token (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

Wait for the user to provide the token.

### Configure environment

Add to `.env`:

```bash
grep -q '^TELEGRAM_BOT_TOKEN=' .env 2>/dev/null && sed -i '' "s/^TELEGRAM_BOT_TOKEN=.*/TELEGRAM_BOT_TOKEN=<their-token>/" .env || echo "TELEGRAM_BOT_TOKEN=<their-token>" >> .env
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Disable Group Privacy (for group chats)

Tell the user:

> **Important for group chats**: By default, Telegram bots only see @mentions and commands in groups. To let the bot see all messages:
>
> 1. Open Telegram and search for `@BotFather`
> 2. Send `/mybots` and select your bot
> 3. Go to **Bot Settings** > **Group Privacy** > **Turn off**
>
> This is optional if you only want trigger-based responses via @mentioning the bot.

### Build and restart

```bash
npm install
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> 1. Open your bot in Telegram (search for its username)
> 2. Send `/chatid` — it will reply with the chat ID
> 3. For groups: add the bot to the group first, then send `/chatid` in the group

Wait for the user to provide the chat ID (format: `tg:123456789` or `tg:-1001234567890`).

### Register the chat

For a main chat (responds to all messages):

```bash
npx tsx setup/index.ts --step register \
  --jid "tg:<chat-id>" \
  --name "<chat-name>" \
  --trigger "@${ASSISTANT_NAME}" \
  --folder "telegram_main" \
  --channel telegram \
  --is-main \
  --no-trigger-required
```

For additional chats (trigger-only):

```bash
npx tsx setup/index.ts --step register \
  --jid "tg:<chat-id>" \
  --name "<chat-name>" \
  --trigger "@${ASSISTANT_NAME}" \
  --folder "telegram_<group-name>" \
  --channel telegram \
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your registered Telegram chat:
> - For main chat: Any message works
> - For non-main: `@Nano hello` or @mention the bot
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. `ENABLE_TELEGRAM=true` is set in `.env`
2. `TELEGRAM_BOT_TOKEN` is set in `.env` AND synced to `data/env/env`
3. Chat is registered in SQLite: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'tg:%'"`
4. For non-main chats: message includes trigger pattern
5. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### Bot only responds to @mentions in groups

Group Privacy is enabled (default). Fix:
1. `@BotFather` > `/mybots` > select bot > **Bot Settings** > **Group Privacy** > **Turn off**
2. Remove and re-add the bot to the group (required for the change to take effect)

### Getting chat ID

If `/chatid` doesn't work:
- Verify token: `curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"`
- Check bot is started: `tail -f logs/nanoclaw.log`

## After Setup

If running `npm run dev` while the service is active:
```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux:
# systemctl --user stop nanoclaw
# npm run dev
# systemctl --user start nanoclaw
```

## Removal

To remove Telegram integration:

1. Disable the feature flag: `sed -i '' 's/^ENABLE_TELEGRAM=.*/ENABLE_TELEGRAM=false/' .env`
2. Remove `TELEGRAM_BOT_TOKEN` from `.env`
3. Remove Telegram registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'tg:%'"`
4. Sync env: `mkdir -p data/env && cp .env data/env/env`
5. Rebuild and restart: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
