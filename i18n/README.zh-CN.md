# 🐿️ gitmunk

[English](../README.md) · **[简体中文](README.zh-CN.md)** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [العربية](README.ar.md) · [Русский](README.ru.md)

本页译自英文 README 的提交 [5ed4276](https://github.com/amyteq/gitmunk/blob/5ed427694c220c82f7394498f1d8067f0d31f5d5/README.md)，可能落后于英文原文。

[![CI](https://github.com/amyteq/gitmunk/actions/workflows/ci.yml/badge.svg)](https://github.com/amyteq/gitmunk/actions/workflows/ci.yml)
[![最新版本](https://img.shields.io/github/v/release/amyteq/gitmunk?style=flat-square&label=release)](https://github.com/amyteq/gitmunk/releases)
[![MIT 许可证](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](../LICENSE)

一个口袋大小的工具包，为使用 Claude Code 和 Codex 的小团队提供智能体技能、护栏钩子和 GitHub 工作流。一个插件市场，两个插件；项目需要什么就只装什么。

| 插件 | 新增内容 |
| --- | --- |
| [`dev-skills`](../plugins/dev-skills) | 八个用于 GitHub 工作的智能体技能：把 issue 细化为工单、审查和合并 PR、解释待定决策、压缩冗长的讨论串、跟踪系列讨论，以及规划功能和 story。参见[技能](#技能)。 |
| [`dev-hooks`](../plugins/dev-hooks) | 面向 Claude Code 的护栏与审计钩子 |

GitHub Actions：可复用的“Ask agent”工作流（[`.github/workflows/ask-agent.yml`](../.github/workflows/ask-agent.yml)）让 Claude Code 或 Codex 回复 issue、PR 和讨论中的提及。从 [`templates/github/`](../templates/github) 复制精简的调用方工作流即可。

## 快速开始

1. 按照[安装](#安装)中的说明安装插件。
2. 在某个 GitHub 仓库的检出目录中，确保 GitHub CLI（`gh`）已登录，然后把一个 issue 变成工单：

   ```text
   /dev-refine-issue 42
   ```

   在 Codex 中，以 `$dev-refine-issue 42` 调用。该技能读取 issue 和仓库的 `AGENTS.md`，然后发布一条任务评论，其中包含验收标准和可复制的启动提示词。它不会实现该 issue。

## 工作原理

- **一个插件市场，两个插件。** 本仓库是一个插件市场（[`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)），其中列出了 `dev-skills` 和 `dev-hooks`。Claude Code 和 Codex 会把每个插件安装到各自的插件缓存中，因此不会向你的仓库复制任何文件。
- **技能**是附带小型 Node.js 辅助脚本的指令。当你按名称调用某个技能时，智能体才会加载它，读取仓库的 `AGENTS.md` 和 `CLAUDE.md` 以了解项目规则，并且只执行该技能所描述的写入操作。
- **钩子**（`dev-hooks`，仅限 Claude Code）是在工具调用前后运行的 Python 脚本。它们会拒绝破坏性调用和读取机密信息的调用，或就此向你确认；阻止合并他人的 PR；并记录脱敏后的事件。
- **Ask 工作流**是一个可复用的 GitHub Actions 工作流，让 Claude Code 或 Codex 回复 issue、PR 和讨论中的 `@claude` 与 `@codex` 提及。仓库从 [`templates/github/`](../templates/github) 复制一个精简的调用方工作流；只有当某个智能体对应的仓库变量为 `true` 且其机密已设置时，该智能体才会运行。
- **渠道**就是分支：稳定版来自 `main`，测试版来自 `develop`，分别使用两个插件市场名称。参见[版本](#版本)。

## 技能

| 技能 | 功能 |
| --- | --- |
| [`dev-refine-issue`](../plugins/dev-skills/skills/dev-refine-issue/SKILL.md) | 将现有 issue 细化为有边界的工单，包含可观察的验收标准、一条独立的任务评论和可复制的启动提示词。它从不实现该 issue。 |
| [`dev-review-pr`](../plugins/dev-skills/skills/dev-review-pr/SKILL.md) | 借助独立的 Codex 或 Claude Code 会话，运行有边界的 PR 审查与修复轮次，给出关联证据的处置结论，并在批准前进行一次最终的完整审查。 |
| [`dev-merge`](../plugins/dev-skills/skills/dev-merge/SKILL.md) | 在所有者明确要求时，以 squash 方式合并一个已审查的 PR，验证合并后的代码树，完成清理，发布一条收尾评论，并更新关联的 issue 和跟踪器。它从不主动合并。 |
| [`dev-explain`](../plugins/dev-skills/skills/dev-explain/SKILL.md) | 解释某个 issue、PR 或讨论中有待人工决定的事项，提供背景、示例、建议以及各选项的比较，然后追加一条结果评论。它不做任何决定。 |
| [`dev-compact`](../plugins/dev-skills/skills/dev-compact/SKILL.md) | 按级别压缩某个 issue、PR 或讨论：在正文中保留要点，将细节原样移到新评论中，并追加一条结果评论。AUTO 区域和验收标准保持逐字节不变。 |
| [`dev-track`](../plugins/dev-skills/skills/dev-track/SKILL.md) | 将某个分类（例如会议记录）下所有未处理的讨论收集到该分类的跟踪讨论中，合并其中的 TODO，把每条讨论标记为已完成并关闭。默认只生成草稿，只有加上 `--apply` 才会写入。 |
| [`dev-analyse-rp`](../plugins/dev-skills/skills/dev-analyse-rp/SKILL.md) | 将一个请求包（本地路径、issue 或讨论）分析为仅用于规划的提案，包含故事地图、交付切片、候选单元、依赖关系图和一次独立审查。只有在明确授权后，它才会开一个包含 feat 与 story 文档的 PR，并附带标签和跟踪 issue。 |
| [`dev-refine-story`](../plugins/dev-skills/skills/dev-refine-story/SKILL.md) | 将一个 `STY_<n>` story 解析为恰好一个 GitHub issue，然后移交给 `dev-refine-issue`。它从不实现该 story。 |

## 安装

运行安装程序（需要 Node.js 20 或更高版本）。它会询问渠道、作用域和智能体，打印每一个步骤，并且在你确认之前不做任何更改：

```bash
npx --allow-git=root github:amyteq/gitmunk
```

npm 12 只有在加上 `--allow-git=root` 时才会直接从 git 仓库运行包。[安装指南](../docs/install.md)介绍了安装程序的问题和参数、作用域、测试版渠道、设置模板、更新、卸载和故障排查。

如需改为手动安装：

### Claude Code

```bash
claude plugin marketplace add amyteq/gitmunk#main
claude plugin install dev-skills@gitmunk
claude plugin install dev-hooks@gitmunk      # optional: the guardrail hooks
```

如需与团队共享这些插件，请改为将 [`templates/claude/settings.json`](../templates/claude/settings.json) 合并到项目的 `.claude/settings.json` 中。

### Codex

```bash
codex plugin marketplace add amyteq/gitmunk --ref main
codex plugin add dev-skills@gitmunk
npm ci --prefix "${CODEX_HOME:-$HOME/.codex}/plugins/cache/gitmunk/dev-skills/<version>"
```

Codex 不会安装插件的 npm 依赖，因此最后一条命令用于安装辅助脚本所需的包；`<version>` 即 `codex plugin list` 显示的版本。

## 版本

渠道就是分支：`main` 是稳定版，`develop` 是测试版。每个插件在 `.claude-plugin/plugin.json` 中的 `version` 必须变更，已安装的副本才会更新。参见 [CHANGELOG.md](../CHANGELOG.md)。

### 渠道

| 渠道 | 插件市场 | Ref | 插件 ID | 模板 |
| --- | --- | --- | --- | --- |
| 稳定版（默认） | `gitmunk` | `main` 的最新提交 | `dev-skills@gitmunk`、`dev-hooks@gitmunk` | [`templates/claude/settings.json`](../templates/claude/settings.json) |
| 测试版 | `gitmunk-beta`（[目录](../channels/beta/.claude-plugin/marketplace.json)） | `develop` 的最新提交，版本形如 `0.3.0-beta.1` | `dev-skills@gitmunk-beta`、`dev-hooks@gitmunk-beta` | [`templates/claude/settings.beta.json`](../templates/claude/settings.beta.json) |

项目要启用测试版，可将测试版模板合并到项目的 `.claude/settings.local.json`（仅对你生效）或 `.claude/settings.json`（对整个团队生效）中。两个插件市场之所以使用不同的名称，是因为 Claude Code 在整台机器上为每个插件市场名称只登记一个来源；测试版模板还会把稳定版插件设为 `false`，这样用户级的稳定版安装就不会在该项目中重复加载相同的技能。Codex 没有第二个渠道：请把项目 `.codex/config.toml` 中 `[marketplaces.gitmunk]` 的 `ref` 指向 `develop`，而不是 `main`。当某个测试版成为正式发布时，其插件的版本号会去掉 `-beta.N` 后缀，`develop` 会被合并到 `main`，测试版项目也可以移除测试版模板。对于合并到 `main` 的 PR，除非 `CHANGELOG.md` 最上方的章节是纯粹的 `## X.Y.Z`、没有任何版本带预发布后缀，并且 `vX.Y.Z` 尚未被打标签，否则[发布工作流](../.github/workflows/release.yml)会让该 PR 检查失败；合并之后，它会打上 `vX.Y.Z` 标签，并以该章节作为发行说明发布一个 GitHub 发行版。

如需固定到某个提交，请在各工具接受 SHA 的地方使用完整的 40 位 SHA：

- **Claude Code** 在 v2.1.324 之前，只会把插件市场 URL 的 `#…` 后缀以及插件市场的 `ref` 当作分支或标签读取；在那里使用 SHA 会因找不到分支而失败（v2.1.324 及之后的版本也接受完整 SHA 作为插件市场的 `ref`）。如需支持旧版本，请改为在你自己的插件市场中（例如项目的 `.claude-plugin/marketplace.json`）逐个固定插件，使用 `git-subdir` 来源及其 `sha`：

  ```json
  { "name": "dev-skills", "source": { "source": "git-subdir", "url": "https://github.com/amyteq/gitmunk.git", "path": "plugins/dev-skills", "sha": "<full commit SHA>" } }
  ```

- **Codex** 接受 SHA 作为插件市场的 ref：`codex plugin marketplace add amyteq/gitmunk --ref <full commit SHA>`。
- **Ask 工作流** 接受调用方 `uses:` 中 `@` 之后的 SHA。

## 常见问题

**为什么有两个插件市场名称？** Claude Code 在整台机器上为每个插件市场名称只登记一个来源，因此同一个名称无法既在你的用户设置中对应 `main`，又在某个项目中对应 `develop`。稳定版是 `gitmunk`（来自 `main`），测试版是 `gitmunk-beta`（来自 `develop`）。参见[渠道](#渠道)。

**某个技能的名称与另一个插件的技能冲突，该如何调用？** 加上插件前缀：在 Claude Code 中使用 `/dev-skills:dev-review-pr`。Codex 总是以带前缀的形式列出插件技能，即 `dev-skills:dev-review-pr`。

**为什么 Codex 需要 `npm ci --prefix`？** `dev-skills` 的辅助脚本需要一个锁定版本的 npm 包。Claude Code 会根据插件的 `package-lock.json` 安装它，但 Codex 不会安装插件的 npm 依赖，所以请在安装或更新后运行一次 `npm ci --prefix "<installed plugin folder>"`。

**如何固定版本？** 在各工具接受 SHA 的地方使用完整的 40 位提交 SHA；[版本](#版本)一节给出了 Claude Code、Codex 和 Ask 工作流的写法。每个发布版本也会打上 `vX.Y.Z` 标签。

**Ask 工作流默认开启吗？** 不开启。从 0.3.0 起，只有当某个智能体的仓库变量（`CLAUDE_ACTION_ENABLED` 或 `CODEX_ACTION_ENABLED`）为 `true` 且其机密能传递到工作流时，该智能体才会运行；否则运行会在路由阶段停止，并在日志中记录原因。参见[设置仓库](../scripts/github-agent/README.md#set-up-a-repository)。

## 数据

> **占位：** 暂无测量数据。有了数据之后，本节将展示使用与不使用这些技能时的运行结果。

## 使用前后对比

> **占位：** 暂无完整示例。本节将展示同一个任务在使用与不使用某个技能时的完成情况。

## 使用 gitmunk 构建的项目

> **占位：** 目前尚未列出任何公开项目。使用 gitmunk 并希望被列出的项目将添加到这里。

## 文档

| 文档 | 涵盖内容 |
| --- | --- |
| [安装指南](../docs/install.md) | 在 Claude Code 和 Codex 中安装、更新和移除 gitmunk：安装程序、作用域、渠道、模板和故障排查 |
| [CHANGELOG.md](../CHANGELOG.md) | 每个版本的变更，附迁移说明 |
| [AGENTS.md](../AGENTS.md) | 在本仓库中工作的规则 |
| [`dev-skills`](../plugins/dev-skills/README.md) | 八个技能、它们的权限范围及其设置 |
| [工作模型](../plugins/dev-skills/references/work-model.md) | `dev-analyse-rp` 和 `dev-refine-story` 所遵循的 `ft-sty` feat 与 story 模型 |
| [`dev-hooks`](../plugins/dev-hooks/README.md) | 每个钩子、它会拒绝或询问的内容，以及它的失败策略 |
| [Ask agent](../scripts/github-agent/README.md) | 在仓库中设置 Ask 工作流 |
| [`templates/claude/`](../templates/claude) | 稳定版和测试版渠道的设置模板 |
| [`templates/github/`](../templates/github) | Ask 调用方工作流 |

## 开发

```bash
node scripts/sync-shared.mjs            # copy shared/ helpers into each plugin
node scripts/sync-shared.mjs --check    # CI: fail on drift
(cd plugins/dev-skills && npm ci && npm test)
python3 -m unittest discover -s plugins/dev-hooks/tests
python3 -m unittest discover -s scripts/github-agent/tests
python3 -m unittest discover -s scripts/release/tests
```

共享辅助脚本只在 `shared/` 中编辑；各插件携带的是同步后的副本，因为每个插件都作为独立的缓存安装。

## 参与贡献

变更先合入 `develop`，即测试版渠道；`main` 只接收来自 `develop` 的发布。请在任务分支上工作，并向 `develop` 提交一个聚焦的 PR。遵循 [AGENTS.md](../AGENTS.md) 中的规则：仅限公开内容；共享辅助脚本只在 `shared/` 中编辑；需要让使用者收到的插件变更，要将该插件的版本提升为 `X.Y.Z-beta.N`，并添加一条 `CHANGELOG.md` 条目。推送之前，请运行[开发](#开发)中的检查。

## 赞助

赞助通过 GitHub Sponsors 进行，赞助对象是 [`.github/FUNDING.yml`](../.github/FUNDING.yml) 中指定的 `amyteq` 组织。待该组织的 Sponsors 资料获批后，仓库的 Sponsor 按钮即可使用；在此之前，该按钮不会指向任何页面。

## Star 历史

<a href="https://www.star-history.com/?repos=amyteq%2Fgitmunk&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date&amp;theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date" />
    <img alt="gitmunk Star 历史" src="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date" />
  </picture>
</a>

## 许可证

[MIT](../LICENSE)
