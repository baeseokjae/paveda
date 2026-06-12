---
name: pr
model: standard
description: "GitHub Flow 기반 PR 생성 스킬. main에서 브랜치를 만들고, push 후 PR을 생성한다. 사용자가 PR 생성, 풀리퀘스트 만들기, push 등을 요청하면 이 스킬을 사용한다."
argument-hint: "[--title \"제목\"] [--draft]"
disable-model-invocation: true
allowed-tools: Bash(git *), Bash(gh *), Bash(bash scripts/*), Bash(rg *), Read, Write, Edit, Grep
---

# /pr - GitHub Flow PR 생성

Squash merge 환경에서 안전하게 PR을 생성한다.
**핵심 원칙: 브랜치는 일회용이다** — merge된 브랜치를 재사용하면 conflict가 발생한다.

## Usage

```
/pr                      # 자동 분석 + PR 생성
/pr --title "제목"       # PR 제목 지정
/pr --draft              # Draft PR 생성
```

## Two-stage review gate

PR 생성 전 반드시 2단계 리뷰를 수행한다.

1. **Spec compliance review**
   - 변경사항이 연결된 spec/acceptance criteria/run objective를 만족하는지 확인한다.
   - 필요한 경우 `paveda verify --run <id> --stage review --write` 또는 evidence kind `spec_compliance_review`를 기록한다.
2. **Code quality review**
   - 테스트, 타입, lint, 보안/데이터 손상 위험, 불필요한 refactor를 확인한다.
   - 필요한 경우 evidence kind `code_quality_review`를 기록한다.

리뷰 결과는 Paveda EventStore에 `review.stage`와 `review.severity` 이벤트로 남아야 한다. `high` severity가 있으면 PR 생성 전에 수정하거나 사용자에게 명확히 보고한다.

## 실행 순서

### 1. 상태 확인 (병렬 실행)

다음 4개 명령을 **병렬**로 실행:

```bash
git fetch origin
git status --short
git log --oneline -10
git rev-parse --abbrev-ref HEAD
```

- origin refs를 최신으로 갱신
- uncommitted 변경사항 확인 → **있으면 "먼저 /commit 하세요" 안내 후 종료**
- 최근 커밋 히스토리 파악
- 현재 브랜치명 파악 → 2단계 분기 기준

### 2. 브랜치 상태 진단

현재 브랜치에 따라 **Case A** 또는 **Case B**로 분기한다.

---

#### Case A: 현재 브랜치가 `main`인 경우

```bash
git log origin/main..HEAD --oneline
```

- **로컬 커밋이 없으면** → "PR 생성할 변경사항이 없습니다" 안내 후 종료
- **로컬 커밋이 있으면** → 커밋 내용을 분석하여 브랜치명 결정 후:

```bash
git checkout -b <branch-name>
```

→ 3단계(Push + PR)로 진행.

---

#### Case B: 현재 브랜치가 feature 브랜치인 경우

먼저 **병렬**로 PR 상태를 확인:

```bash
gh pr list --head <current-branch> --state merged --json number,title --limit 1
gh pr list --head <current-branch> --state open --json number,title,url --limit 1
```

결과에 따라 3가지로 분기:

##### B-1. 이미 merge된 PR이 있음 (conflict 방지 핵심)

⚠️ Squash merge 후 같은 브랜치를 재사용하면 conflict가 발생한다.

사용자에게 경고:
> "이 브랜치(`<name>`)는 이미 PR #N으로 merge되었습니다."

미merge 커밋을 식별:

```bash
git cherry -v origin/main HEAD
```

`+`로 표시된 커밋(아직 main에 없는 커밋)을 수집한다.

- **새 커밋이 없으면** → "모든 변경사항이 이미 main에 merge되었습니다" 안내 후 종료
- **새 커밋이 있으면** → 새 브랜치를 만들고 cherry-pick:

```bash
# 커밋 내용에 기반한 새 브랜치명 결정
git checkout origin/main
git checkout -b <new-branch-name>
git cherry-pick <commit-hash-1> <commit-hash-2> ...
```

cherry-pick conflict 발생 시 사용자에게 안내하고 해결을 맡긴다.
성공 시 → 3단계(Push + PR)로 진행.

##### B-2. 이미 open PR이 있음

사용자에게 안내:
> "이 브랜치에 이미 PR #N이 open 상태입니다: <url>"

추가 커밋을 push:

```bash
git push origin <branch-name>
```

PR URL을 보고 후 종료.

##### B-3. merged/open PR 없음 (정상 케이스)

PR 대상 커밋이 있는지 확인:

```bash
git log origin/main..HEAD --oneline
```

커밋이 없으면 → "PR 생성할 변경사항이 없습니다" 종료.

브랜치 기반이 최신인지 확인:

```bash
git merge-base --is-ancestor origin/main HEAD
```

- **ancestor가 맞으면** (브랜치가 origin/main 위에 있음) → 그대로 3단계로 진행
- **ancestor가 아니면** (main이 앞서감) → remote에 이미 push된 브랜치인지 확인:

```bash
git ls-remote --heads origin <branch-name>
```

  - **remote에 없으면** → rebase 후 진행:
    ```bash
    git rebase origin/main
    ```
    rebase conflict 시 사용자에게 안내.

  - **remote에 있으면** → rebase 시 force push가 필요하므로 사용자에게 안내:
    > "main이 앞서가서 conflict 가능성이 있습니다. 새 브랜치를 만들까요?"
    사용자 승인 시 새 브랜치 생성 + cherry-pick (B-1과 동일 방식).

### 3. Push + PR 생성

```bash
git push -u origin <branch-name> 2>&1 | tail -20

gh pr create \
  --base main \
  --head <branch-name> \
  --title "<제목>" \
  --body "$(cat <<'EOF'
## Summary
<변경사항 요약 — 1~3줄 불릿>

## Test plan
<테스트 체크리스트>
EOF
)"
```

**PR 제목 규칙** (Squash merge 시 main 커밋 메시지가 됨):
- Conventional Commit 형식: `<type>: <한글 설명>`
- 70자 이내
- 커밋이 1개면 커밋 메시지 그대로 사용
- 커밋이 여러 개면 핵심 변경을 요약

**PR 본문 규칙**:
- Summary: 주요 변경사항을 1~3줄 불릿으로
- Test plan: 테스트 체크리스트 (타입체크, 테스트 통과 여부 등)
- `git diff origin/main...<branch-name> --stat`으로 변경 파일 목록 확인

### 4. 정리 + 결과 보고

worktree 환경 여부에 따라 분기:

```bash
# worktree 환경 감지
git rev-parse --git-common-dir
# ".git"이면 일반 환경, 그 외 경로면 worktree 환경
```

- **일반 환경**: `git checkout main` 실행 후 PR URL 보고
- **worktree 환경**: main이 다른 worktree에서 사용 중이므로 checkout 생략, 현재 브랜치에서 PR URL만 보고

## 브랜치 이름 규칙

- ASCII 문자만 사용 (소문자, 숫자, 하이픈, 슬래시)
- 한국어/유니코드 절대 금지
- 포맷: `<type>/<간결한-설명>` (예: `fix/jsonl-session-output`)
- type은 커밋 메시지의 type을 따름

## 주의사항

- **구현 작업 완료 후 가능하면 새 세션에서 실행** — 긴 세션의 컨텍스트가 API 호출마다 재전송되어 rate limit 유발
- uncommitted 변경이 있으면 PR 생성 전에 먼저 /commit을 안내
- `git push --force`는 절대 사용하지 않음
- rebase/cherry-pick conflict는 사용자에게 보여주고 판단을 맡김
- 브랜치 이름에 한국어 사용 금지 (GitHub에서 hidden character로 처리됨)
- PR 생성 후 반드시 URL을 보고
- **merge된 브랜치를 절대 재사용하지 않음** — 항상 새 브랜치를 생성

## $ARGUMENTS

- (none): 자동 분석 + PR 생성
- `--title "제목"`: PR 제목 직접 지정
- `--draft`: Draft PR로 생성
