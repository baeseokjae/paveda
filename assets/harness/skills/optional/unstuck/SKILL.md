---
name: unstuck
model: standard
description: "Nine Minds 스타일 lateral thinking으로 막힌 문제를 재구성한다. 사용자가 막혔다, 다른 관점이 필요하다, unstuck이 필요하다고 요청하면 사용한다."
argument-hint: "<problem statement>"
allowed-tools: Read, Grep, Bash(rg *), Bash(git diff *)
---

# /unstuck - Five Minds lateral thinking

막힌 문제를 5개의 관점으로 짧게 재해석하고, 즉시 실행 가능한 next move를 고른다.

## Personas

1. **Contrarian** — 현재 가정 중 틀렸을 가능성이 가장 큰 것을 찾는다.
2. **Simplifier** — 문제를 줄여서 15분 안에 검증 가능한 최소 재현/최소 변경으로 만든다.
3. **Hacker** — 우회로, 기존 도구 재사용, 빠른 instrumentation을 제안한다.
4. **Researcher** — 문서/선례/로그에서 확인해야 할 사실을 분리한다.
5. **Architect** — 구조적 원인, 경계, 장기 비용을 점검한다.

## Process

1. 문제와 현재 시도/실패 증거를 5줄 이내로 요약한다.
2. 각 persona가 하나씩 hypothesis와 action을 낸다.
3. action을 impact/effort/risk로 정렬한다.
4. 최종적으로 **one next move**만 선택하고, 성공/실패 판정 기준을 붙인다.

## Output format

- Problem frame
- Five minds table: Persona / Hypothesis / Action / Evidence needed
- Recommended next move
- Stop condition: 언제 이 방향을 버릴지

## Guardrails

- 새 아키텍처 제안보다 먼저 작은 검증을 선호한다.
- 근거 없는 대형 refactor를 금지한다.
- 이미 실패한 접근은 같은 형태로 반복하지 않는다.
