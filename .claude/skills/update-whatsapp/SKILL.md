---
name: update-whatsapp
description: Review and cherry-pick new upstream-whatsapp changes using incremental reviewed-whatsapp-vN tags. Only shows changes since last review.
---

# About

Your WhatsApp channel fork drifts from upstream-whatsapp as you customize it. This skill shows only **new** upstream-whatsapp changes since your last review, lets you cherry-pick what you want, and advances the review tag so you never re-review skipped changes.

Run `/update-whatsapp` in Claude Code.

## How it works

**Tag-based tracking**: Uses `reviewed-whatsapp-vN` tags on `upstream-whatsapp/main` to track what you've already reviewed. Each run only shows changes since the last tag.

**Preview**: Groups new changes by category (source, skills, config, docs) and shows a summary.

**Cherry-pick**: You pick which commits to apply to trunk. Related commits can be squashed.

**Advance tag**: After review, creates `reviewed-whatsapp-v(N+1)` at the current `upstream-whatsapp/main` so next run starts from there.

## Token usage

Only opens files with actual conflicts. Uses `git log`, `git diff`, and `git status` for everything else. Does not scan or refactor unrelated code.

---

# Goal
Help the user review and selectively incorporate upstream-whatsapp changes without re-reviewing previously skipped changes.

# Operating principles
- Never proceed with a dirty working tree.
- Use `reviewed-whatsapp-vN` tags to track review progress — never show already-reviewed changes.
- Cherry-pick is the only update path. No merge, no rebase.
- When squashing multiple cherry-picked commits, prefix the message with `(squash)`.
- Keep token usage low: rely on `git status`, `git log`, `git diff`, and open only conflicted files.
- WhatsApp file layout differs between trunk and upstream — handle path differences during cherry-pick conflict resolution:

  | Trunk (local) | Upstream |
  |---------------|----------|
  | `src/channels/whatsapp/index.ts` | `src/channels/whatsapp.ts` |
  | `src/channels/whatsapp/index.test.ts` | `src/channels/whatsapp.test.ts` |
  | `src/whatsapp-auth.ts` | `src/whatsapp-auth.ts` |
  | `setup/whatsapp-auth.ts` | `setup/whatsapp-auth.ts` |
  | `.claude/skills/setup-whatsapp/SKILL.md` | `.claude/skills/add-whatsapp/SKILL.md` |

# Step 0: Preflight

Run:
- `git status --porcelain`
If output is non-empty:
- Tell the user to commit or stash first, then stop.

Fetch upstream-whatsapp:
- `git fetch upstream-whatsapp --prune --tags`

Confirm `upstream-whatsapp` remote exists:
- `git remote -v`
If `upstream-whatsapp` is missing:
- Ask the user for the upstream repo URL (default: `https://github.com/qwibitai/nanoclaw-whatsapp`).
- Add it: `git remote add upstream-whatsapp <user-provided-url>`
- Re-fetch: `git fetch upstream-whatsapp --prune --tags`

# Step 1: Find last review tag

Find the latest `reviewed-whatsapp-vN` tag:
```bash
git tag -l 'reviewed-whatsapp-v*' --sort=-version:refname | head -1
```

Store as `LAST_TAG`. If no tag exists:
- Use AskUserQuestion: "No reviewed-whatsapp-vN tag found. This appears to be your first run. Want me to show ALL changes between upstream-whatsapp/main and trunk, or create reviewed-whatsapp-v1 at the current upstream-whatsapp/main and start fresh next time?"
- If start fresh: create `reviewed-whatsapp-v1` at `upstream-whatsapp/main`, push it, and stop.
- If show all: set `LAST_TAG` to the merge-base of trunk and upstream-whatsapp/main.

# Step 2: Preview new changes

Show only commits added since the last review:
```bash
git log --oneline --no-merges $LAST_TAG..upstream-whatsapp/main | grep -vE '(bump version|update token count|add.*contributor)'
```

If no new commits:
- Tell the user "No new upstream-whatsapp changes since $LAST_TAG" and stop.

Show file-level impact:
```bash
git diff --name-only $LAST_TAG..upstream-whatsapp/main
```

Bucket the changed files:
- **Source** (`src/`): may conflict if you modified the same files
- **Skills** (`.claude/skills/`): unlikely to conflict unless you edited an upstream skill
- **Container** (`container/`): agent-runner, Dockerfile, skills
- **Build/config** (`package.json`, `tsconfig*.json`): review needed
- **Tests** (`*.test.ts`): usually safe
- **Docs**: docs, README, CHANGELOG
- **Other**: everything else

**New files**: If `git diff --name-only` shows files that don't exist on trunk, call them out explicitly and note where they should go (using the path mapping from Operating Principles). Update the mapping table in this skill file if the new files become permanent.

For each meaningful commit, show a brief (3-4 word) description of what it adds and whether it's compatible with trunk:
```
| Commit | What it adds | Compatible? |
|--------|-------------|-------------|
| `abc1234` | getMessage retry cache | ✅ yes |
| `def5678` | senderPn LID fallback | ✅ yes |
| `ghi9012` | OneCLI gateway setup | ❌ we removed OneCLI |
```

**Compatibility check**: For each commit, compare it against trunk's current architecture and local changes. Run:
```bash
git diff $COMMIT~1..$COMMIT -- . | head -200
```
Flag a commit as incompatible if:
- It modifies code paths that trunk has **refactored, renamed, or removed** (e.g. references to deleted files, old variable names, removed features).
- It assumes infrastructure or dependencies that trunk **no longer uses** (e.g. OneCLI, old session paths).
- It would **revert or conflict** with intentional local customizations.

Mark compatible commits with checkmark, questionable ones with warning (explain why), and incompatible ones with X (explain why). Recommend skipping incompatible commits outright.

Present to the user and ask using AskUserQuestion:
- A) **Cherry-pick**: select specific commits to apply
- B) **Abort**: done reviewing, advance the tag without applying anything
- C) **Abort without advancing**: just wanted to peek, don't move the tag

If Abort (B): skip to Step 5 (advance tag).
If Abort without advancing (C): stop here.

If Cherry-pick (A): ask the user which commits they want, then ask using AskUserQuestion:
- **Squash** — combine all selected commits into one commit
- **Individual** — apply each commit separately

If Squash: after cherry-picking, `git reset --soft HEAD~N && git commit` with a `(squash)` prefixed summary message. Include the original commit hashes and messages in the body, e.g.:
```
(squash) fix: upstream whatsapp improvements

Cherry-picked from upstream-whatsapp/main:
- abc1234 getMessage retry cache
- def5678 senderPn LID fallback
```

# Step 3: Cherry-pick

Apply the selected commits:
```bash
git cherry-pick <hash1> <hash2> ...
```

If squashing was chosen, squash after all cherry-picks succeed (see Step 2 for format).

If conflicts during cherry-pick:
- Show conflicted files.
- Open only conflicted files, resolve conflict markers.
- Preserve intentional local customizations.
- Do not refactor surrounding code.
- `git add <file>` then `git cherry-pick --continue`

If user wants to stop mid-cherry-pick:
- `git cherry-pick --abort`

After cherry-picks are done, run validation:
- `npm run build`
- `npm test` (don't fail the flow if tests aren't configured)

If build fails:
- Show the error.
- Only fix issues clearly caused by the cherry-pick (missing imports, type mismatches).
- Do not refactor unrelated code.
- If unclear, ask the user.

# Step 4: Advance review tag

Determine the next version number:
```bash
LAST_NUM=$(git tag -l 'reviewed-whatsapp-v*' --sort=-version:refname | head -1 | sed 's/reviewed-whatsapp-v//')
NEXT_NUM=$((LAST_NUM + 1))
```

If no previous tag exists, use `NEXT_NUM=1`.

Create and push the new tag:
```bash
git tag reviewed-whatsapp-v$NEXT_NUM upstream-whatsapp/main
git push origin reviewed-whatsapp-v$NEXT_NUM
```

# Step 5: Summary

Show:
- Previous review tag: `$LAST_TAG`
- New review tag: `reviewed-whatsapp-v$NEXT_NUM`
- Commits applied (list them)
- Commits skipped (list them — these won't show up next time)
- Conflicts resolved (list files, if any)

Tell the user:
- Run `/rebuild-everything` to apply changes to containers and service.

## Diagnostics

1. Use the Read tool to read `.claude/skills/update-whatsapp/diagnostics.md`.
2. Follow every step in that file before finishing.
