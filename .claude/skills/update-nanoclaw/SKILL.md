---
name: update-nanoclaw
description: Review and cherry-pick new upstream changes using incremental reviewed-vN tags. Only shows changes since last review.
---

# About

Your NanoClaw fork drifts from upstream as you customize it. This skill shows only **new** upstream changes since your last review, lets you cherry-pick what you want, and advances the review tag so you never re-review skipped changes.

Run `/update-nanoclaw` in Claude Code.

## How it works

**Tag-based tracking**: Uses `reviewed-vN` tags on `origin/main` to track what you've already reviewed. Each run only shows changes since the last tag.

**Preview**: Groups new changes by category (source, skills, config, docs) and shows a summary.

**Cherry-pick**: You pick which commits to apply to trunk. Related commits can be squashed.

**Advance tag**: After review, creates `reviewed-v(N+1)` at the current `origin/main` so next run starts from there.

## Token usage

Only opens files with actual conflicts. Uses `git log`, `git diff`, and `git status` for everything else. Does not scan or refactor unrelated code.

---

# Goal
Help the user review and selectively incorporate upstream changes without re-reviewing previously skipped changes.

# Operating principles
- Never proceed with a dirty working tree.
- Always create a rollback point (backup branch + tag) before cherry-picking.
- Use `reviewed-vN` tags to track review progress — never show already-reviewed changes.
- Cherry-pick is the only update path. No merge, no rebase.
- When squashing multiple cherry-picked commits, prefix the message with `(squash)`.
- Keep token usage low: rely on `git status`, `git log`, `git diff`, and open only conflicted files.

# Step 0: Preflight

Run:
- `git status --porcelain`
If output is non-empty:
- Tell the user to commit or stash first, then stop.

Sync upstream to origin/main:
- `git fetch upstream --prune`
- `git push origin upstream/main:main`

This ensures `origin/main` mirrors `upstream/main`. No local `main` branch needed.

Then fetch origin:
- `git fetch origin --prune --tags`

Confirm `upstream` remote exists:
- `git remote -v`
If `upstream` is missing:
- Ask the user for the upstream repo URL (default: `https://github.com/qwibitai/nanoclaw.git`).
- Add it: `git remote add upstream <user-provided-url>`
- Re-fetch: `git fetch upstream --prune`
- Sync: `git push origin upstream/main:main`
- Re-fetch origin: `git fetch origin --prune --tags`

# Step 1: Find last review tag

Find the latest `reviewed-vN` tag:
```bash
git tag -l 'reviewed-v*' --sort=-version:refname | head -1
```

Store as `LAST_TAG`. If no tag exists:
- Use AskUserQuestion: "No reviewed-vN tag found. This appears to be your first run. Want me to show ALL changes between origin/main and trunk, or create reviewed-v1 at the current origin/main and start fresh next time?"
- If start fresh: create `reviewed-v1` at `origin/main`, push it, and stop.
- If show all: set `LAST_TAG` to the merge-base of trunk and origin/main.

# Step 2: Preview new changes

Show only commits added since the last review:
```bash
git log --oneline --no-merges $LAST_TAG..origin/main | grep -vE '(bump version|update token count|add.*contributor)'
```

If no new commits:
- Tell the user "No new upstream changes since $LAST_TAG" and stop.

Show file-level impact:
```bash
git diff --name-only $LAST_TAG..origin/main
```

Bucket the changed files:
- **Source** (`src/`): may conflict if you modified the same files
- **Skills** (`.claude/skills/`): unlikely to conflict unless you edited an upstream skill
- **Container** (`container/`): agent-runner, Dockerfile, skills
- **Build/config** (`package.json`, `tsconfig*.json`): review needed
- **Tests** (`*.test.ts`): usually safe
- **Docs**: docs, README, CHANGELOG
- **Other**: everything else

For each meaningful commit, show a brief (3-4 word) description of what it adds and whether it's compatible with trunk:
```
| Commit | What it adds | Compatible? |
|--------|-------------|-------------|
| `abc1234` | per-group trigger patterns | ✅ yes |
| `def5678` | timezone validation fix | ⚠️ conflicts with our config refactor |
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

Mark compatible commits with ✅, questionable ones with ⚠️ (explain why), and incompatible ones with ❌ (explain why). Recommend skipping ❌ commits outright.

Present to the user and ask using AskUserQuestion:
- A) **Cherry-pick**: select specific commits to apply
- B) **Abort**: done reviewing, advance the tag without applying anything
- C) **Abort without advancing**: just wanted to peek, don't move the tag

If Abort (B): skip to Step 5 (advance tag).
If Abort without advancing (C): stop here.

# Step 3: Create a safety net

Before any cherry-picks:
- `HASH=$(git rev-parse --short HEAD)`
- `TIMESTAMP=$(date +%Y%m%d-%H%M%S)`
- `git branch backup/pre-update-$HASH-$TIMESTAMP`
- `git tag pre-update-$HASH-$TIMESTAMP`

Save the tag name for rollback instructions.

# Step 4: Cherry-pick

Ask the user which commit hashes they want. Apply them:
```bash
git cherry-pick <hash1> <hash2> ...
```

If the user wants multiple related commits squashed:
- Cherry-pick them all, then `git reset --soft HEAD~N && git commit` with a `(squash)` prefixed message.

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

# Step 5: Advance review tag

Determine the next version number:
```bash
LAST_NUM=$(git tag -l 'reviewed-v*' --sort=-version:refname | head -1 | sed 's/reviewed-v//')
NEXT_NUM=$((LAST_NUM + 1))
```

Create and push the new tag:
```bash
git tag reviewed-v$NEXT_NUM origin/main
git push origin reviewed-v$NEXT_NUM
```

# Step 6: Summary

Show:
- Previous review tag: `$LAST_TAG`
- New review tag: `reviewed-v$NEXT_NUM`
- Commits applied (list them)
- Commits skipped (list them — these won't show up next time)
- Conflicts resolved (list files, if any)
- Backup tag for rollback: `pre-update-$HASH-$TIMESTAMP`

Tell the user:
- To rollback: `git reset --hard pre-update-$HASH-$TIMESTAMP`
- Run `/rebuild-everything` to apply changes to containers and service.

## Diagnostics

Send diagnostics data by following `.claude/skills/update-nanoclaw/diagnostics.md`.
