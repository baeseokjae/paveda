---
name: commit
model: standard
description: "Auto-generate git commits by analyzing staged/unstaged changes and generating conventional commit messages. Use when the user asks to commit, save changes, or create a git commit."
argument-hint: "[-m \"message\"] [--dry-run]"
disable-model-invocation: true
allowed-tools: Bash(git *)
---

# /commit - Git Commit

Analyzes changes and auto-generates a commit message to create a commit.

## Usage

```
/commit                  # Auto-generate message + commit
/commit -m "message"     # Manual message
/commit --dry-run        # Preview message only, no commit
```

## Execution Order

### 1. Check Status (parallel execution)

Run the following 3 commands **in parallel**:

```bash
git status
git diff --staged && git diff
git log --oneline -5
```

- Check list of changed/added/deleted files
- Check staged + unstaged change contents
- Reference recent commit message style

### 2. Sensitive File Check

Warn if sensitive files (credentials, secret, key, etc.) not defined in `.gitignore` are included in the change list.
Files already in `.gitignore` are automatically excluded by git, so no separate handling is needed.

### 3. Generate Commit Message

Analyze the changes and compose a message.

**Format**: `<type>: <korean description>`

**Type classification**:
| type | When to use |
|------|----------|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code improvement without behavior change |
| `test` | Add/modify tests |
| `docs` | Documentation changes |
| `chore` | Config, dependencies, build, etc. |

**Message rules**:
- 1-line summary (under 70 characters)
- Focus on "why" the change was made
- Summarize the core change when multiple files are modified
- **Never** add `Co-Authored-By` line

### 4. Stage and Commit

```bash
# Stage specific files only (never use git add -A)
git add <file1> <file2> ...

# Commit with HEREDOC (without Co-Authored-By)
# Hook output suppression: pre-commit hook(lint+test)의 전체 출력이 컨텍스트에 쌓이는 것을 방지
git commit -m "$(cat <<'EOF'
<type>: <message>
EOF
)" 2>&1 | tail -20
```

### 5. Verify Result

```bash
git status
```

Check whether the commit succeeded and report the result.

## Important Notes

- **구현 작업 완료 후 가능하면 새 세션에서 실행** — 긴 세션의 컨텍스트가 API 호출마다 재전송되어 rate limit 유발
- Never use `git add -A` or `git add .` (to prevent including sensitive files)
- Never skip hooks with `--no-verify`, etc.
- Never use `--amend` (always create a new commit)
- On pre-commit hook failure: fix the issue, then create a **new commit**
- Never add `Co-Authored-By` line

## $ARGUMENTS

- (none): Auto-generate message + commit
- `-m "message"`: Commit with manual message
- `--dry-run`: Generate message only, do not commit
