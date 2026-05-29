# Paveda Policy Runtime / Control Plane 구현 계획

작성일: 2026-05-29
상태: proposed implementation plan

## 1. 목표

Paveda의 목표는 Claude Code, Codex, Hermes, Pi 등 어떤 agent 플랫폼을 쓰더라도 같은 작업 규칙을 따르게 만드는 것이다.

핵심은 Paveda가 단순한 rule file 배포기가 되면 안 된다는 점이다. `AGENTS.md`, `CLAUDE.md`, `.codex/hooks.json`, skill, plugin manifest 같은 host별 파일은 host가 Paveda를 발견하고 호출하기 위한 호환 표면일 뿐이다. 규칙의 원천은 이 파일들이 아니라 Paveda 런타임이어야 한다.

권위 있는 기준은 다음 네 가지다.

1. Paveda policy runtime
2. 공통 event / decision model
3. host별 lifecycle을 공통 모델로 변환하는 adapter
4. 실제 이벤트와 policy decision을 남기는 EventStore

## 2. 현재 구조의 문제

현재 코드베이스는 아직 "portable harness bundle" 중심이다.

- `docs/spec.md`는 Paveda를 canonical harness로 설명하고, host별 산출물을 렌더링한다고 말한다.
- `docs/architecture.md`는 `host-bundles`를 canonical asset을 host directory로 렌더링하는 핵심 모듈로 둔다.
- `src/hook-runtime/index.ts`에는 이미 유용한 guard 로직이 있지만, 정책 판단이 lifecycle dispatch 안에 섞여 있다.
- `src/install/claude-code.ts`는 Claude Code hook 설치만 다루며, Codex/Hermes/Pi adapter는 아직 없다.

이 구조는 좋은 출발점이지만, 사용자가 원하는 목표와는 중심이 다르다. 앞으로는 host bundle을 "compatibility export"로 낮추고, policy runtime을 중심으로 재정의해야 한다.

## 3. 보강 리서치 결과

### Claude Code

Claude Code hook은 지원되는 lifecycle에 대해 강한 enforcement 지점이 될 수 있다. `PreToolUse`는 tool 실행 전에 동작하고, hook 응답에서 `hookSpecificOutput.permissionDecision: "deny"`를 반환하면 tool call을 막을 수 있다.

따라서 Claude Code는 지원 action에 대해 Tier 1 hard-block 대상이다.

Reference: https://code.claude.com/docs/en/hooks

### Codex

Codex도 `PreToolUse`, `PermissionRequest`, `PostToolUse`, `SessionStart`, `Stop` 등 lifecycle hook을 지원한다. `PreToolUse`와 `PermissionRequest`는 지원되는 범위에서 deny가 가능하다.

다만 Codex 문서는 `PreToolUse`를 완전한 enforcement boundary가 아니라 guardrail로 설명한다. 같은 작업이 다른 tool 경로로 가능할 수 있고, shell 실행도 모든 형태가 완전히 intercept되는 것은 아니라고 명시되어 있다.

따라서 Codex는 "Claude Code와 같은 hard block"이라고 가정하면 안 된다. `doctor --enforcement`가 action별로 실제 보장 수준을 판정해야 한다.

Codex는 1차 설계 범위에 managed config까지 포함한다.

- `requirements.toml`
- managed hook directory
- hook feature pinning
- `allow_managed_hooks_only`
- sandbox policy
- network policy
- filesystem deny rule
- command rule
- approval policy

References:

- https://developers.openai.com/codex/hooks
- https://developers.openai.com/codex/config-reference

### MCP

MCP는 resources, prompts, tools를 노출하는 공통 인터페이스로 쓸 수 있다. Paveda가 `paveda mcp serve`를 제공하면 여러 host가 같은 Paveda wrapper tool을 사용할 수 있다.

하지만 MCP 자체가 완전한 보안 경계는 아니다. MCP spec은 tool이 임의 코드 실행 경로가 될 수 있고, consent / authorization / access control은 구현자가 책임져야 한다고 설명한다.

따라서 MCP gateway는 native host tool이 비활성화되거나 제한될 때 강한 enforcement가 된다. native tool이 열려 있으면 mediated layer이며 bypass risk를 명시해야 한다.

Reference: https://modelcontextprotocol.io/specification/2025-11-25

### Rule Sync 계열 프로젝트

RuleSync 같은 프로젝트는 하나의 기준 정의에서 여러 AI tool config를 생성한다. 이는 compatibility export 패턴으로 비교할 수 있지만, Paveda의 핵심 목표를 단독으로 만족하지 않는다.

Paveda의 목적은 규칙 파일을 여러 곳에 뿌리는 것이 아니라, 모든 host가 같은 policy runtime을 통과하게 만드는 것이다.

Reference: https://github.com/dyoshikawa/rulesync

### Reference Monitor 방향

가장 가까운 구조는 reference monitor다.

Host별 adapter가 lifecycle/tool event를 Paveda의 deterministic policy decision point로 보내고, Paveda는 `allow`, `deny`, `ask`, `warn`, `record_only` 같은 결정을 반환한다. Adapter는 host capability에 따라 그 결정을 강제하거나 기록한다.

Reference: https://blog.sondera.ai/p/hooking-coding-agents-with-the-cedar

## 4. 아키텍처 결정

Paveda는 policy runtime / control plane으로 구현한다.

```text
Host agent
  -> host adapter
  -> normalized AgentEvent
  -> PolicyEngine
  -> PolicyDecision
  -> host-specific enforcement response
  -> EventStore lineage
```

Host별 instruction file, skill bundle, hook config는 계속 유용하지만 다음처럼 정의한다.

```text
Paveda policy runtime = authoritative
Host files / skills / hooks = adapter and discovery surfaces
Generated rule files = compatibility hints, not policy authority
```

## 5. Core Model

### AgentEvent

Host lifecycle을 다음 공통 이벤트로 정규화한다.

- `session.started`
- `prompt.submitted`
- `tool.requested`
- `tool.completed`
- `file.mutated`
- `verification.completed`
- `session.stopped`

### PolicyDecision

PolicyEngine은 구조화된 결정을 반환한다.

- `allow`
- `warn`
- `deny`
- `ask`
- `require_step`
- `record_only`

각 decision은 다음 정보를 포함한다.

- rule id
- severity
- reason
- required host capability
- suggested remediation
- evidence payload
- enforced 여부

### HostCapability

강제력은 host 단위가 아니라 tool/action 단위로 판단한다.

예시 필드:

- `canBlockBeforeTool`
- `canGatePermissionRequest`
- `canRewriteToolInput`
- `canStopAfterTool`
- `supportsManagedConfig`
- `supportsMcpGateway`
- `nativeToolBypassRisk`
- `coveredToolMatchers`

이 구조가 "tool 특성에 따라가면 된다"는 결정에 대응한다.

## 6. Enforcement Tier

Paveda는 host/action별 실효 강제력을 tier로 보고해야 한다.

| Tier | 이름 | 의미 |
|---|---|---|
| 1 | `block` | side effect 전에 Paveda가 실행을 차단할 수 있음 |
| 2 | `gate` | approval, permission, sandbox, managed config로 조건부 제한 가능 |
| 3 | `mediate` | Paveda MCP/tool wrapper를 경유할 때만 강제 가능 |
| 4 | `verify` | live 차단은 못 하지만 verification, commit, PR, CI gate에서 실패 처리 가능 |

제품 문구는 "모든 플랫폼에서 동일한 hard enforcement"가 아니어야 한다. 정확한 표현은 "모든 플랫폼에서 같은 정책을 해석하고, host/action별 enforcement strength를 명시한다"이다.

## 7. Workflow State Machine

작업 규칙은 정적 instruction file이 아니라 session state로 강제한다.

상태:

1. `intake`
2. `specifying`
3. `planning`
4. `executing`
5. `verifying`
6. `handoff`

예시 규칙:

- 원인 파악 요청이면 root-cause evidence 전에는 mutation을 차단하거나 gate한다.
- 구현 계획 요청이면 사용자가 진행을 승인하기 전까지 code mutation을 하지 않는다.
- 파일 변경 후에는 verification evidence 없이 commit/PR을 진행하지 않는다.
- destructive command는 Tier 1 action이면 deny, 약한 host면 gate 또는 verify decision으로 처리한다.

## 8. Host Adapter 계획

### Claude Code Adapter

Claude Code는 첫 번째 strong enforcement target으로 둔다.

- `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`을 `AgentEvent`로 매핑한다.
- Tier 1 block은 `permissionDecision: "deny"`로 반환한다.
- 사용자 확인이 필요하면 `ask` decision을 host 응답으로 변환한다.
- 기존 `.claude/settings.json` 설치기는 유지하되, 개념을 bundle installer가 아니라 Paveda adapter installer로 재정의한다.

### Codex Adapter

Codex는 personal config와 managed config를 모두 1차 범위에 포함한다.

- `.codex/hooks.json` 생성/검증
- inline `[hooks]` config 생성/검증
- managed `requirements.toml` 생성/가이드
- managed hook directory 지원
- `allow_managed_hooks_only = true` 지원
- hook feature pinning 지원
- approval / sandbox / network / filesystem / command rule 반영
- `doctor --enforcement`로 action별 tier 판정

Codex는 first-class adapter로 구현하되, 문서상 bypass surface가 있으므로 hard-block 보장을 과장하지 않는다.

### Hermes Adapter

Hermes는 MCP-only로 끝내지 않는다. plugin / tool registry / profile surface를 직접 조사하고 first-class adapter를 만든다.

초기 작업:

- Hermes plugin API 조사
- Hermes tool registry 조사
- lifecycle interception 가능 여부 확인
- tool call을 `AgentEvent`로 매핑
- block / gate / mediate / verify 가능 범위 판정
- Hermes `HostCapability` matrix 작성
- strongest path에 대한 enforcement smoke test 추가

### Pi Adapter

Pi도 first-class adapter로 다룬다.

초기 작업:

- Pi package / extension API 조사
- permission-system extension pattern 조사
- tool call과 workflow event를 `AgentEvent`로 매핑
- side effect 전 block 가능 여부 확인
- Pi `HostCapability` matrix 작성
- strongest path에 대한 enforcement smoke test 추가

## 9. MCP Gateway 계획

다음 명령을 추가한다.

```bash
paveda mcp serve
```

노출할 policy-aware tool:

- `paveda.search`
- `paveda.read`
- `paveda.patch`
- `paveda.shell`
- `paveda.git`
- `paveda.test`

모든 MCP tool call은 `AgentEvent`로 정규화하고, `PolicyEngine`을 통과하고, EventStore에 기록한 뒤, 허용된 경우에만 실행한다.

MCP gateway는 Claude Code, Codex, Hermes, Pi 및 future host에서 공통 경로가 된다. 단, native host tool이 열려 있으면 bypass risk를 보고해야 한다.

## 10. Enforcement Doctor

다음 명령을 추가한다.

```bash
paveda doctor --enforcement --host <host>
```

probe 대상:

- destructive shell command
- sensitive file mutation
- dependency manifest mutation
- verification 전 commit
- verification 전 PR
- MCP-routed tool call
- 관측 가능한 native host tool call

출력:

- effective tier
- passed probes
- failed probes
- bypass paths
- required remediation
- 설치/수정해야 할 config file
- managed config 활성 여부

## 11. 구현 단계

### Phase 0. 문서 재정의

- `docs/spec.md`와 `docs/architecture.md`를 policy runtime 중심으로 수정한다.
- 이 문서는 transition plan으로 유지한다.
- host bundle 문서는 compatibility export 문서로 재정의한다.

### Phase 1. Core Types

- `AgentEvent`, `PolicyDecision`, `HostCapability`, `PolicyRule` 타입 추가
- policy decision EventStore serializer 추가
- type guard / decision normalization unit test 추가

### Phase 2. PolicyEngine

- `PolicyEngine.evaluate(event, state, config)` 추가
- 기존 guard를 rule로 포팅
  - destructive guard
  - blast check
  - tooling enforce
  - cost guard
  - test cleanup
  - session context
- 기존 behavior를 test로 보존

### Phase 3. Workflow State

- EventStore 기반 session workflow state projection 추가
- `specify -> plan -> execute -> verify -> handoff` transition 강제
- debugging / verification / commit / PR gate policy 추가

### Phase 4. Host Adapters

- Claude Code adapter를 공통 모델 중심으로 리팩터링
- Codex adapter에 personal config + managed config 지원 추가
- Hermes adapter 조사 및 구현
- Pi adapter 조사 및 구현

### Phase 5. MCP Gateway

- `paveda mcp serve` 추가
- wrapper tool 1차 구현
- 모든 wrapper tool을 `PolicyEngine` 경유로 실행
- bypass-risk reporting 추가

### Phase 6. Enforcement Doctor

- `doctor --enforcement` 추가
- synthetic probe 추가
- host/action tier matrix 출력
- CI-safe smoke test 추가

### Phase 7. Compatibility Export 정리

- `skills install-bundle`은 유지하되 compatibility export로 문서화
- portable skills는 user-facing context module로 유지하고 enforcement authority로 취급하지 않음
- generated host file을 canonical policy처럼 설명하는 문구 제거

## 12. Acceptance Criteria

1차 완료 기준:

- 단일 `PolicyEngine`이 normalized event를 평가한다.
- 기존 guard behavior가 새 policy model 아래에서 보존된다.
- EventStore가 raw event와 policy decision을 모두 기록한다.
- `doctor --enforcement`가 host/action별 capability tier를 출력한다.
- Claude Code에서 synthetic destructive command를 hard-block할 수 있다.
- Codex managed config 생성/검증이 `requirements.toml`까지 포함한다.
- Hermes/Pi adapter capability matrix와 smoke test가 있다.
- MCP gateway가 shell, patch, git, test action을 중재한다.
- 문서가 Paveda를 rule distribution system이 아니라 policy runtime으로 설명한다.

## 13. Non-goals

- 모든 플랫폼에서 동일한 hard enforcement를 약속하지 않는다.
- generated `AGENTS.md` 또는 `SKILL.md`를 enforcement source로 삼지 않는다.
- ride 전용 rule을 Paveda core에 넣지 않는다.
- project-domain hook을 Paveda core로 끌어오지 않는다.
- native tool이 열려 있는데 MCP를 완전한 security boundary로 설명하지 않는다.

## 14. 확정된 기본 결정

현재 기본 결정:

1. 강제력은 host가 아니라 tool/action capability를 따른다.
2. Codex는 managed config까지 1차 설계 범위에 포함한다.
3. Hermes/Pi는 MCP-only가 아니라 plugin/extension API까지 깊게 조사한다.
4. host-specific file은 compatibility export로 둔다.
5. `doctor --enforcement`를 현재 환경에서 Paveda가 실제로 보장 가능한 것을 증명하는 메커니즘으로 둔다.
