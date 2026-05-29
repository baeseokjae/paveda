---
name: verify
description: "AGENTS.md Verification Checklist를 자동 실행. lint, test, build + 테스트 커버리지 확인. 코드 변경 후 품질 검증이 필요할 때 사용."
argument-hint: "[--quick]"
allowed-tools: Bash, Glob, Grep, Read
---

# /verify — Automated Verification

AGENTS.md의 Verification Checklist를 자동 실행한다. 변경된 파일을 감지하고, lint → test → build → 커버리지 확인을 순차 실행하여 pass/fail을 판정한다.

## Usage

```
/verify              # 전체 체크리스트 (lint + test + build + 커버리지)
/verify --quick      # 빠른 검증 (lint + test만, build 스킵)
```

## Execution Order

### Phase 1: Parse Arguments

1. `$ARGUMENTS`에서 `--quick` 플래그 확인 → QUICK_MODE 설정
2. 잘못된 인수가 있으면 usage 안내 후 중단

### Phase 2: Collect Changed Files

변경된 파일 목록을 수집한다:

```bash
# staged + unstaged 변경 파일
git diff --name-only HEAD 2>/dev/null || git diff --name-only
# untracked 파일
git ls-files --others --exclude-standard
```

결과를 CHANGED_FILES에 저장. 변경 없으면 "변경 사항 없음" 보고 후 계속 진행.

### Phase 3: Resolve Project Commands

현재 repo의 package manager metadata와 manifest scripts를 기준으로 명령을 정한다.
명령이 없으면 해당 항목은 `skipped`로 기록하고, 새 설정 파일이나 script를 만들지 않는다.

```bash
PKG_MANAGER="pnpm"
PACKAGE_MANAGER_FIELD=""
if [ -f package.json ]; then
  PACKAGE_MANAGER_FIELD=$(node -e "const p=require('./package.json'); console.log(p.packageManager || '')" 2>/dev/null || true)
fi
case "$PACKAGE_MANAGER_FIELD" in
  npm@*) PKG_MANAGER="npm" ;;
  yarn@*) PKG_MANAGER="yarn" ;;
  pnpm@*) PKG_MANAGER="pnpm" ;;
esac
[ -f pnpm-lock.yaml ] && PKG_MANAGER="pnpm"
[ -f package-lock.json ] && PKG_MANAGER="npm"
[ -f yarn.lock ] && PKG_MANAGER="yarn"
```

### Phase 4: Lint

```bash
[ -f package.json ] && node -e "const p=require('./package.json'); process.exit(p.scripts?.lint ? 0 : 1)" && ${PKG_MANAGER} lint
```

- 통과 → LINT_RESULT = "pass"
- 실패 → LINT_RESULT = "fail", 에러 내용 기록
- script 없음 → LINT_RESULT = "skipped"

### Phase 5: Test

```bash
[ -f package.json ] && node -e "const p=require('./package.json'); process.exit(p.scripts?.test ? 0 : 1)" && ${PKG_MANAGER} test
```

- 통과 → TEST_RESULT = "pass"
- 실패 → TEST_RESULT = "fail", 실패한 테스트 목록 기록
- script 없음 → TEST_RESULT = "skipped"

### Phase 6: Build (--quick 시 스킵)

QUICK_MODE가 아닌 경우에만 실행:

```bash
[ -f package.json ] && node -e "const p=require('./package.json'); process.exit(p.scripts?.build ? 0 : 1)" && ${PKG_MANAGER} build
```

- 통과 → BUILD_RESULT = "pass"
- 실패 → BUILD_RESULT = "fail", 에러 내용 기록
- QUICK_MODE 또는 script 없음 → BUILD_RESULT = "skipped"

### Phase 7: Test Coverage Check

CHANGED_FILES 중 source file로 보이는 파일에 대해:

1. Glob으로 대응하는 테스트 파일 존재 여부 확인:
   - 같은 디렉터리의 `*.test.*` 또는 `*.spec.*`
   - repo-level `tests/`, `test/`, `__tests__/`, 언어별 test 디렉터리
2. 테스트 파일이 없는 소스 파일 목록을 UNCOVERED_FILES에 기록
3. 타입/선언 파일, 설정 파일, 생성 파일은 제외

### Phase 8: Report

결과를 테이블로 출력:

```
## Verification Results

| Check | Result |
|-------|--------|
| Lint | ✅ pass |
| Test | ✅ pass |
| Build | pass/skipped/fail |
| Coverage | ⚠️ 2 files without tests |

### 전체 판정: ✅ PASS (또는 ❌ FAIL)
```

FAIL 판정 기준:
- Lint, Test, Build 중 하나라도 fail
- 모든 verification command가 skipped이면 WARN으로 보고하고 사용 가능한 검증 명령을 제안

Coverage 미충족은 경고(⚠️)로만 표시 — FAIL 판정에 포함하지 않음.

## $ARGUMENTS

- (none): 전체 체크리스트 실행
- `--quick`: lint + test만 (build 스킵)
