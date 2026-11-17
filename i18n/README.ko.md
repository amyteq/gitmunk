# 🐿️ gitmunk

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **[한국어](README.ko.md)** · [Español](README.es.md) · [Français](README.fr.md) · [العربية](README.ar.md) · [Русский](README.ru.md)

이 페이지는 영어 README의 커밋 [5ed4276](https://github.com/amyteq/gitmunk/blob/5ed427694c220c82f7394498f1d8067f0d31f5d5/README.md)에서 번역했으며 영어 원문보다 오래되었을 수 있습니다.

[![CI](https://github.com/amyteq/gitmunk/actions/workflows/ci.yml/badge.svg)](https://github.com/amyteq/gitmunk/actions/workflows/ci.yml)
[![최신 릴리스](https://img.shields.io/github/v/release/amyteq/gitmunk?style=flat-square&label=release)](https://github.com/amyteq/gitmunk/releases)
[![MIT 라이선스](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](../LICENSE)

Claude Code와 Codex로 일하는 소규모 팀을 위한, 에이전트 스킬과 가드레일 훅, GitHub 워크플로를 담은 주머니 크기의 툴킷입니다. 마켓플레이스 하나에 플러그인 둘이며, 프로젝트에 필요한 것만 설치하면 됩니다.

| 플러그인 | 추가하는 기능 |
| --- | --- |
| [`dev-skills`](../plugins/dev-skills) | GitHub 작업용 에이전트 스킬 8개: 이슈를 작업 지시서로 정제하고, PR을 리뷰하고 병합하며, 보류 중인 결정을 설명하고, 긴 스레드를 압축하고, 디스커션 시리즈를 추적하고, 기능과 스토리를 계획합니다. [스킬](#스킬)을 참고하세요. |
| [`dev-hooks`](../plugins/dev-hooks) | Claude Code용 가드레일 및 감사 훅 |

GitHub Actions: 재사용 가능한 "Ask agent" 워크플로([`.github/workflows/ask-agent.yml`](../.github/workflows/ask-agent.yml))를 사용하면 Claude Code나 Codex가 이슈, PR, 디스커션의 멘션에 답할 수 있습니다. 얇은 호출 워크플로는 [`templates/github/`](../templates/github)에서 복사하세요.

## 빠른 시작

1. [설치](#설치)에 나온 대로 플러그인을 설치합니다.
2. GitHub CLI(`gh`)에 로그인한 상태로 GitHub 저장소의 체크아웃 안에서 이슈를 작업 지시서로 만듭니다:

   ```text
   /dev-refine-issue 42
   ```

   Codex에서는 `$dev-refine-issue 42`로 호출합니다. 이 스킬은 이슈와 저장소의 `AGENTS.md`를 읽은 다음, 인수 기준과 복사해 쓸 수 있는 실행 프롬프트가 담긴 작업 코멘트를 게시합니다. 이슈를 구현하지는 않습니다.

## 작동 방식

- **마켓플레이스 하나, 플러그인 둘.** 이 저장소는 `dev-skills`와 `dev-hooks`를 등록한 플러그인 마켓플레이스([`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json))입니다. Claude Code와 Codex는 각 플러그인을 자체 플러그인 캐시에 설치하므로 여러분의 저장소에는 아무것도 복사되지 않습니다.
- **스킬**은 작은 Node.js 헬퍼가 딸린 지침입니다. 이름으로 호출하면 에이전트가 해당 스킬을 불러오고, 프로젝트 규칙을 확인하려고 저장소의 `AGENTS.md`와 `CLAUDE.md`를 읽으며, 스킬에 적힌 쓰기 작업만 수행합니다.
- **훅**(`dev-hooks`, Claude Code 전용)은 도구 호출 전후에 실행되는 Python 스크립트입니다. 파괴적인 호출과 비밀 정보를 읽는 호출을 거부하거나 확인을 요청하고, 다른 사람의 PR 병합을 막으며, 민감 정보를 가린 이벤트를 기록합니다.
- **Ask 워크플로**는 Claude Code나 Codex가 이슈, PR, 디스커션의 `@claude`, `@codex` 멘션에 답하게 하는 재사용 가능한 GitHub Actions 워크플로입니다. 저장소는 [`templates/github/`](../templates/github)에서 얇은 호출 워크플로를 복사하며, 각 에이전트는 해당 저장소 변수가 `true`이고 시크릿이 설정된 경우에만 실행됩니다.
- **채널**은 브랜치입니다. 안정 채널은 `main`에서, 베타 채널은 `develop`에서 나오며, 서로 다른 두 마켓플레이스 이름으로 제공됩니다. [버전](#버전)을 참고하세요.

## 스킬

| 스킬 | 하는 일 |
| --- | --- |
| [`dev-refine-issue`](../plugins/dev-skills/skills/dev-refine-issue/SKILL.md) | 기존 이슈를 관찰 가능한 인수 기준, 독립된 작업 코멘트, 복사해 쓸 수 있는 실행 프롬프트를 갖춘 범위가 정해진 작업 지시서로 정제합니다. 이슈를 구현하지는 않습니다. |
| [`dev-review-pr`](../plugins/dev-skills/skills/dev-review-pr/SKILL.md) | 독립된 Codex 또는 Claude Code 세션으로 범위가 정해진 PR 리뷰·수정 라운드를 실행하고, 증거에 연결된 처리 결과를 남기며, 승인 전에 최종 전체 리뷰를 수행합니다. |
| [`dev-merge`](../plugins/dev-skills/skills/dev-merge/SKILL.md) | 소유자가 명시적으로 요청하면 리뷰를 마친 PR 하나를 스쿼시 병합하고, 병합된 트리를 검증하고, 정리한 뒤, 마무리 코멘트를 게시하고 연결된 이슈와 트래커를 업데이트합니다. 스스로 판단해 병합하지는 않습니다. |
| [`dev-explain`](../plugins/dev-skills/skills/dev-explain/SKILL.md) | 이슈, PR 또는 디스커션 하나에서 사람이 내려야 할 보류 중인 결정을 배경, 예시, 권장안, 선택지 비교와 함께 설명한 뒤 결과 코멘트 하나를 추가합니다. 아무것도 결정하지 않습니다. |
| [`dev-compact`](../plugins/dev-skills/skills/dev-compact/SKILL.md) | 이슈, PR 또는 디스커션 하나를 수준별로 압축합니다. 핵심은 본문에 남기고, 세부 내용은 새 코멘트로 그대로 옮기며, 결과 코멘트 하나를 추가합니다. AUTO 영역과 인수 기준은 바이트 단위로 동일하게 유지됩니다. |
| [`dev-track`](../plugins/dev-skills/skills/dev-track/SKILL.md) | 회의록처럼 한 카테고리에 속한 미처리 디스커션을 모두 그 카테고리의 트래커 디스커션으로 모으고, TODO를 병합하고, 각 디스커션에 완료 표시를 한 뒤 닫습니다. 기본적으로 초안만 만들고 `--apply`를 지정했을 때만 씁니다. |
| [`dev-analyse-rp`](../plugins/dev-skills/skills/dev-analyse-rp/SKILL.md) | 요청 팩 하나(로컬 경로, 이슈 또는 디스커션)를 스토리 맵, 딜리버리 슬라이스, 후보 단위, 의존성 그래프, 독립 리뷰를 갖춘 계획 전용 제안으로 분석합니다. 명시적인 승인이 있을 때만 feat 및 story 문서를 담은 PR 하나를 레이블, 추적 이슈와 함께 엽니다. |
| [`dev-refine-story`](../plugins/dev-skills/skills/dev-refine-story/SKILL.md) | `STY_<n>` 스토리를 정확히 하나의 GitHub 이슈로 확정한 뒤 `dev-refine-issue`에 넘깁니다. 스토리를 구현하지는 않습니다. |

## 설치

설치 프로그램을 실행합니다(Node.js 20 이상). 설치 프로그램은 채널, 스코프, 에이전트를 묻고, 모든 단계를 출력하며, 확인하기 전까지는 아무것도 변경하지 않습니다:

```bash
npx --allow-git=root github:amyteq/gitmunk
```

npm 12는 `--allow-git=root`가 있어야만 git 저장소에서 패키지를 바로 실행합니다. [설치 가이드](../docs/install.md)는 설치 프로그램의 질문과 플래그, 스코프, 베타 채널, 설정 템플릿, 업데이트, 제거, 문제 해결을 다룹니다.

직접 설치하려면 다음과 같이 합니다:

### Claude Code

```bash
claude plugin marketplace add amyteq/gitmunk#main
claude plugin install dev-skills@gitmunk
claude plugin install dev-hooks@gitmunk      # optional: the guardrail hooks
```

팀과 플러그인을 공유하려면 대신 [`templates/claude/settings.json`](../templates/claude/settings.json)을 프로젝트의 `.claude/settings.json`에 병합하세요.

### Codex

```bash
codex plugin marketplace add amyteq/gitmunk --ref main
codex plugin add dev-skills@gitmunk
npm ci --prefix "${CODEX_HOME:-$HOME/.codex}/plugins/cache/gitmunk/dev-skills/<version>"
```

Codex는 플러그인의 npm 의존성을 설치하지 않으므로, 마지막 명령으로 헬퍼 패키지를 설치합니다. `<version>`은 `codex plugin list`에 표시되는 버전입니다.

## 버전

채널은 브랜치입니다. `main`은 안정 채널, `develop`은 베타 채널입니다. 설치된 사본이 업데이트되려면 각 플러그인의 `.claude-plugin/plugin.json`에 있는 `version`이 바뀌어야 합니다. [CHANGELOG.md](../CHANGELOG.md)를 참고하세요.

### 채널

| 채널 | 마켓플레이스 | Ref | 플러그인 ID | 템플릿 |
| --- | --- | --- | --- | --- |
| 안정(기본값) | `gitmunk` | `main`의 헤드 | `dev-skills@gitmunk`, `dev-hooks@gitmunk` | [`templates/claude/settings.json`](../templates/claude/settings.json) |
| 베타 | `gitmunk-beta` ([카탈로그](../channels/beta/.claude-plugin/marketplace.json)) | `develop`의 헤드, `0.3.0-beta.1` 같은 버전 | `dev-skills@gitmunk-beta`, `dev-hooks@gitmunk-beta` | [`templates/claude/settings.beta.json`](../templates/claude/settings.beta.json) |

프로젝트는 베타 템플릿을 `.claude/settings.local.json`(본인만) 또는 `.claude/settings.json`(팀 전체)에 병합해 베타를 사용합니다. Claude Code는 마켓플레이스 이름마다 머신 전체에서 소스 하나만 등록하므로 두 마켓플레이스의 이름이 다릅니다. 또한 베타 템플릿은 안정 플러그인을 `false`로 설정하므로, 사용자 수준에서 설치한 안정 버전이 그 프로젝트에서 같은 스킬을 두 번 불러오지 않습니다. Codex에는 두 번째 채널이 없으므로, `.codex/config.toml`에서 프로젝트의 `[marketplaces.gitmunk]` `ref`를 `main`이 아닌 `develop`으로 지정하세요. 베타가 릴리스가 되면 해당 플러그인 버전에서 `-beta.N` 접미사가 빠지고, `develop`이 `main`에 병합되며, 베타 프로젝트는 베타 템플릿을 제거해도 됩니다. [릴리스 워크플로](../.github/workflows/release.yml)는 `main`으로 향하는 PR에서 맨 위 `CHANGELOG.md` 섹션이 단순한 `## X.Y.Z`가 아니거나, 어떤 버전이 프리릴리스 접미사를 달고 있거나, `vX.Y.Z` 태그가 이미 있으면 실패합니다. 이후 병합되면 `vX.Y.Z` 태그를 만들고 그 섹션을 릴리스 노트로 삼아 GitHub 릴리스를 게시합니다.

커밋을 고정하려면 각 도구가 SHA를 받는 곳에 40자 전체 SHA를 사용하세요:

- **Claude Code** v2.1.324 이전 버전은 마켓플레이스 URL의 `#…` 접미사와 마켓플레이스 `ref`를 브랜치나 태그로만 읽으므로, 그 자리에 SHA를 쓰면 브랜치가 없다는 오류로 실패합니다(v2.1.324 이상은 마켓플레이스 `ref`에 전체 SHA도 받습니다). 이전 버전을 지원하려면 대신 자체 마켓플레이스(예: 프로젝트의 `.claude-plugin/marketplace.json`)에서 `git-subdir` 소스와 그 `sha`로 각 플러그인을 고정하세요:

  ```json
  { "name": "dev-skills", "source": { "source": "git-subdir", "url": "https://github.com/amyteq/gitmunk.git", "path": "plugins/dev-skills", "sha": "<full commit SHA>" } }
  ```

- **Codex**는 마켓플레이스 ref로 SHA를 받습니다: `codex plugin marketplace add amyteq/gitmunk --ref <full commit SHA>`.
- **Ask 워크플로**는 호출 워크플로의 `uses:`에서 `@` 뒤에 SHA를 받습니다.

## 자주 묻는 질문

**마켓플레이스 이름이 왜 두 개인가요?** Claude Code는 마켓플레이스 이름마다 머신 전체에서 소스 하나만 등록하므로, 한 이름으로 사용자 설정에서는 `main`을, 프로젝트에서는 `develop`을 제공할 수 없습니다. 안정 채널은 `gitmunk`(`main`에서), 베타 채널은 `gitmunk-beta`(`develop`에서)입니다. [채널](#채널)을 참고하세요.

**스킬 이름이 다른 플러그인의 스킬과 겹칩니다. 어떻게 호출하나요?** 플러그인 접두사를 붙이세요. Claude Code에서는 `/dev-skills:dev-review-pr`입니다. Codex는 플러그인 스킬을 항상 `dev-skills:dev-review-pr`처럼 접두사와 함께 표시합니다.

**Codex에는 왜 `npm ci --prefix`가 필요한가요?** `dev-skills` 헬퍼 스크립트에는 버전이 고정된 npm 패키지 하나가 필요합니다. Claude Code는 플러그인의 `package-lock.json`으로 이 패키지를 설치하지만 Codex는 플러그인 npm 의존성을 설치하지 않으므로, 설치하거나 업데이트한 뒤 `npm ci --prefix "<installed plugin folder>"`를 한 번 실행하세요.

**버전을 고정하려면 어떻게 하나요?** 각 도구가 SHA를 받는 곳에 40자 전체 커밋 SHA를 사용하세요. Claude Code, Codex, Ask 워크플로에서 쓰는 형식은 [버전](#버전)에 나와 있습니다. 각 릴리스에는 `vX.Y.Z` 태그도 붙습니다.

**Ask 워크플로는 기본으로 켜져 있나요?** 아니요. 0.3.0부터 에이전트는 해당 저장소 변수(`CLAUDE_ACTION_ENABLED` 또는 `CODEX_ACTION_ENABLED`)가 `true`이고 시크릿이 워크플로에 전달될 때만 실행됩니다. 그렇지 않으면 실행은 라우팅 단계에서 멈추고 그 이유를 로그에 남깁니다. [저장소 설정하기](../scripts/github-agent/README.md#set-up-a-repository)를 참고하세요.

## 수치

> **자리표시자:** 아직 측정값이 없습니다. 측정값이 생기면 이 섹션에서 스킬을 쓴 실행과 쓰지 않은 실행의 결과를 보여 줄 예정입니다.

## 사용 전 / 사용 후

> **자리표시자:** 아직 실제 예시가 없습니다. 이 섹션에서는 한 작업을 스킬을 써서 했을 때와 쓰지 않고 했을 때를 보여 줄 예정입니다.

## gitmunk로 만든 프로젝트

> **자리표시자:** 아직 등록된 공개 프로젝트가 없습니다. gitmunk를 사용하며 이름이 실리기를 원하는 프로젝트를 여기에 추가할 예정입니다.

## 문서

| 문서 | 다루는 내용 |
| --- | --- |
| [설치 가이드](../docs/install.md) | Claude Code와 Codex에서 gitmunk 설치, 업데이트, 제거: 설치 프로그램, 스코프, 채널, 템플릿, 문제 해결 |
| [CHANGELOG.md](../CHANGELOG.md) | 릴리스별 변경 사항과 마이그레이션 안내 |
| [AGENTS.md](../AGENTS.md) | 이 저장소에서 작업할 때의 규칙 |
| [`dev-skills`](../plugins/dev-skills/README.md) | 스킬 8개와 각 스킬의 권한 및 설정 |
| [작업 모델](../plugins/dev-skills/references/work-model.md) | `dev-analyse-rp`와 `dev-refine-story`가 따르는 `ft-sty` feat·story 모델 |
| [`dev-hooks`](../plugins/dev-hooks/README.md) | 각 훅이 거부하거나 확인을 요청하는 대상과 실패 정책 |
| [Ask 에이전트](../scripts/github-agent/README.md) | 저장소에 Ask 워크플로 설정하기 |
| [`templates/claude/`](../templates/claude) | 안정 채널과 베타 채널용 설정 템플릿 |
| [`templates/github/`](../templates/github) | Ask 호출 워크플로 |

## 개발

```bash
node scripts/sync-shared.mjs            # copy shared/ helpers into each plugin
node scripts/sync-shared.mjs --check    # CI: fail on drift
(cd plugins/dev-skills && npm ci && npm test)
python3 -m unittest discover -s plugins/dev-hooks/tests
python3 -m unittest discover -s scripts/github-agent/tests
python3 -m unittest discover -s scripts/release/tests
```

공유 헬퍼는 `shared/`에서만 수정하세요. 각 플러그인은 별도의 캐시로 설치되므로 플러그인마다 동기화된 사본을 가지고 있습니다.

## 기여하기

변경 사항은 베타 채널인 `develop`에 반영되며, `main`은 `develop`에서 나온 릴리스만 받습니다. 작업 브랜치에서 작업하고 `develop`으로 향하는 범위가 좁은 PR을 여세요. [AGENTS.md](../AGENTS.md)의 규칙을 따르세요: 공개 콘텐츠만 다루고, 공유 헬퍼는 `shared/`에서만 수정하며, 사용자가 받아야 하는 플러그인 변경은 해당 플러그인의 버전을 `X.Y.Z-beta.N` 형식으로 올리고 `CHANGELOG.md` 항목을 추가합니다. 푸시하기 전에 [개발](#개발)의 검사를 실행하세요.

## 후원

후원은 `amyteq` 조직의 GitHub Sponsors를 통해 이루어지며, 이 조직은 [`.github/FUNDING.yml`](../.github/FUNDING.yml)에 지정되어 있습니다. 저장소의 Sponsor 버튼은 조직의 Sponsors 프로필이 승인된 후에 작동하며, 그전까지는 아무 곳으로도 연결되지 않습니다.

## 스타 히스토리

<a href="https://www.star-history.com/?repos=amyteq%2Fgitmunk&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date&amp;theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date" />
    <img alt="gitmunk 스타 히스토리" src="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date" />
  </picture>
</a>

## 라이선스

[MIT](../LICENSE)
