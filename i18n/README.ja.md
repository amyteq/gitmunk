# 🐿️ gitmunk

[English](../README.md) · [简体中文](README.zh-CN.md) · **[日本語](README.ja.md)** · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [العربية](README.ar.md) · [Русский](README.ru.md)

このページは英語版 README のコミット [5ed4276](https://github.com/amyteq/gitmunk/blob/5ed427694c220c82f7394498f1d8067f0d31f5d5/README.md) から翻訳したもので、英語版より古い場合があります。

[![CI](https://github.com/amyteq/gitmunk/actions/workflows/ci.yml/badge.svg)](https://github.com/amyteq/gitmunk/actions/workflows/ci.yml)
[![最新リリース](https://img.shields.io/github/v/release/amyteq/gitmunk?style=flat-square&label=release)](https://github.com/amyteq/gitmunk/releases)
[![MIT ライセンス](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](../LICENSE)

Claude Code と Codex を使う小規模チーム向けに、エージェントスキル、ガードレールフック、GitHub ワークフローをまとめたポケットサイズのツールキットです。マーケットプレイスは 1 つ、プラグインは 2 つ。プロジェクトに必要なものだけをインストールできます。

| プラグイン | 追加されるもの |
| --- | --- |
| [`dev-skills`](../plugins/dev-skills) | GitHub での作業のための 8 つのエージェントスキル：issue を作業指示書に仕上げる、PR をレビューしてマージする、保留中の判断を説明する、長いスレッドを圧縮する、ディスカッションのシリーズを追跡する、フィーチャーとストーリーを計画する。[スキル](#スキル) を参照してください。 |
| [`dev-hooks`](../plugins/dev-hooks) | Claude Code 用のガードレールフックと監査フック |

GitHub Actions：再利用可能な「Ask agent」ワークフロー（[`.github/workflows/ask-agent.yml`](../.github/workflows/ask-agent.yml)）により、Claude Code または Codex が issue、PR、ディスカッションでのメンションに応答できます。薄い呼び出し元ワークフローは [`templates/github/`](../templates/github) からコピーしてください。

## クイックスタート

1. [インストール](#インストール) の手順に従ってプラグインをインストールします。
2. GitHub リポジトリのチェックアウト内で、GitHub CLI（`gh`）にサインインした状態で、issue を作業指示書に変換します：

   ```text
   /dev-refine-issue 42
   ```

   Codex では `$dev-refine-issue 42` として呼び出します。スキルは issue とリポジトリの `AGENTS.md` を読み、受け入れ基準とコピーして使える起動プロンプトを含むタスクコメントを投稿します。issue の実装は行いません。

## しくみ

- **マーケットプレイスは 1 つ、プラグインは 2 つ。** このリポジトリはプラグインマーケットプレイス（[`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)）であり、`dev-skills` と `dev-hooks` を掲載しています。Claude Code と Codex はそれぞれのプラグインを各自のプラグインキャッシュにインストールするため、あなたのリポジトリには何もコピーされません。
- **スキル** は小さな Node.js ヘルパーを伴う指示書です。名前で呼び出すとエージェントがそのスキルを読み込み、プロジェクトのルールとしてリポジトリの `AGENTS.md` と `CLAUDE.md` を読み、スキルに記載された書き込みだけを行います。
- **フック**（`dev-hooks`、Claude Code のみ）は、ツール呼び出しの前後で実行される Python スクリプトです。破壊的な呼び出しやシークレットを読み取る呼び出しを拒否または確認し、他人の PR のマージをブロックし、秘匿化したイベントをログに記録します。
- **Ask ワークフロー** は、Claude Code または Codex が issue、PR、ディスカッションでの `@claude` や `@codex` のメンションに応答できるようにする、再利用可能な GitHub Actions ワークフローです。リポジトリは [`templates/github/`](../templates/github) から薄い呼び出し元ワークフローをコピーします。各エージェントは、対応するリポジトリ変数が `true` で、シークレットが設定されている場合にのみ実行されます。
- **チャンネル** はブランチです。安定版は `main` から、ベータ版は `develop` から、それぞれ別のマーケットプレイス名で提供されます。[バージョン](#バージョン) を参照してください。

## スキル

| スキル | 機能 |
| --- | --- |
| [`dev-refine-issue`](../plugins/dev-skills/skills/dev-refine-issue/SKILL.md) | 既存の issue を、観察可能な受け入れ基準、単独で読めるタスクコメント、コピーして使える起動プロンプトを備えた、範囲の明確な作業指示書に仕上げます。issue を実装することはありません。 |
| [`dev-review-pr`](../plugins/dev-skills/skills/dev-review-pr/SKILL.md) | 独立した Codex または Claude Code のセッションで、範囲を限定した PR のレビューと修正のラウンドを実行します。各指摘の処置は根拠にリンクされ、承認前に最終的なフルレビューを行います。 |
| [`dev-merge`](../plugins/dev-skills/skills/dev-merge/SKILL.md) | オーナーが明示的に依頼したときに、レビュー済みの PR を 1 つスカッシュマージし、マージ後のツリーを検証して後片付けを行い、クローズアウトコメントを投稿して、関連する issue とトラッカーを更新します。自らの判断でマージすることはありません。 |
| [`dev-explain`](../plugins/dev-skills/skills/dev-explain/SKILL.md) | 1 つの issue、PR、ディスカッションで人間の判断を待っている事項を、背景、例、推奨案、選択肢の比較とともに説明し、結果コメントを 1 件追加します。何も決定しません。 |
| [`dev-compact`](../plugins/dev-skills/skills/dev-compact/SKILL.md) | 1 つの issue、PR、ディスカッションをレベルに応じて圧縮します。要点は本文に残し、詳細は原文のまま新しいコメントに移し、結果コメントを 1 件追加します。AUTO 領域と受け入れ基準はバイト単位で同一のまま保たれます。 |
| [`dev-track`](../plugins/dev-skills/skills/dev-track/SKILL.md) | 議事録など、1 つのカテゴリの未処理のディスカッションをすべてそのカテゴリのトラッカーディスカッションに集約し、TODO をマージし、それぞれに完了マークを付けてクローズします。デフォルトでは下書きのみを作成し、`--apply` を指定した場合にだけ書き込みます。 |
| [`dev-analyse-rp`](../plugins/dev-skills/skills/dev-analyse-rp/SKILL.md) | 1 つのリクエストパック（ローカルパス、issue、ディスカッションのいずれか）を分析し、ストーリーマップ、デリバリースライス、候補ユニット、依存関係グラフ、独立したレビューを含む計画専用の提案にまとめます。明示的な承認がある場合に限り、feat と story のドキュメントを含む PR を 1 つ作成し、ラベルと追跡用の issue も作成します。 |
| [`dev-refine-story`](../plugins/dev-skills/skills/dev-refine-story/SKILL.md) | `STY_<n>` ストーリーをちょうど 1 つの GitHub issue に対応付け、その後 `dev-refine-issue` に引き継ぎます。ストーリーを実装することはありません。 |

## インストール

インストーラーを実行します（Node.js 20 以降）。インストーラーはチャンネル、スコープ、エージェントを尋ね、すべての手順を表示し、確認するまで何も変更しません：

```bash
npx --allow-git=root github:amyteq/gitmunk
```

npm 12 は、`--allow-git=root` を指定した場合にのみ git リポジトリから直接パッケージを実行します。インストーラーの質問とフラグ、スコープ、ベータチャンネル、設定テンプレート、更新、アンインストール、トラブルシューティングについては [インストールガイド](../docs/install.md) を参照してください。

手動でインストールする場合：

### Claude Code

```bash
claude plugin marketplace add amyteq/gitmunk#main
claude plugin install dev-skills@gitmunk
claude plugin install dev-hooks@gitmunk      # optional: the guardrail hooks
```

チームでプラグインを共有するには、代わりに [`templates/claude/settings.json`](https://github.com/amyteq/gitmunk/blob/5ed427694c220c82f7394498f1d8067f0d31f5d5/templates/claude/settings.json) をプロジェクトの `.claude/settings.json` にマージします。

### Codex

```bash
codex plugin marketplace add amyteq/gitmunk --ref main
codex plugin add dev-skills@gitmunk
npm ci --prefix "${CODEX_HOME:-$HOME/.codex}/plugins/cache/gitmunk/dev-skills/<version>"
```

Codex はプラグインの npm 依存関係をインストールしないため、最後のコマンドでヘルパーのパッケージをインストールします。`<version>` には `codex plugin list` に表示されるバージョンを指定します。

## バージョン

チャンネルはブランチです。`main` が安定版、`develop` がベータ版です。インストール済みのコピーを更新するには、各プラグインの `.claude-plugin/plugin.json` にある `version` を変更する必要があります。[CHANGELOG.md](../CHANGELOG.md) を参照してください。

### チャンネル

| チャンネル | マーケットプレイス | 参照先 | プラグイン ID | テンプレート |
| --- | --- | --- | --- | --- |
| 安定版（デフォルト） | `gitmunk` | `main` の最新コミット | `dev-skills@gitmunk`、`dev-hooks@gitmunk` | [`templates/claude/settings.json`](https://github.com/amyteq/gitmunk/blob/5ed427694c220c82f7394498f1d8067f0d31f5d5/templates/claude/settings.json) |
| ベータ版 | `gitmunk-beta`（[カタログ](../channels/beta/.claude-plugin/marketplace.json)） | `develop` の最新コミット。バージョンは `0.3.0-beta.1` の形式 | `dev-skills@gitmunk-beta`、`dev-hooks@gitmunk-beta` | [`templates/claude/settings.beta.json`](https://github.com/amyteq/gitmunk/blob/5ed427694c220c82f7394498f1d8067f0d31f5d5/templates/claude/settings.beta.json) |

プロジェクトでベータ版を使うには、ベータ版テンプレートを `.claude/settings.local.json`（自分だけ）または `.claude/settings.json`（チーム全体）にマージします。2 つのマーケットプレイスの名前が異なるのは、Claude Code がマシン全体でマーケットプレイス名ごとに 1 つのソースしか登録しないためです。ベータ版テンプレートは安定版プラグインを `false` にも設定するので、ユーザーレベルで安定版をインストールしていても、そのプロジェクトで同じスキルが二重に読み込まれることはありません。Codex には 2 つ目のチャンネルがありません。代わりに、`.codex/config.toml` にあるプロジェクトの `[marketplaces.gitmunk]` の `ref` を `main` ではなく `develop` に向けてください。ベータ版がリリースになると、そのプラグインのバージョンから `-beta.N` サフィックスが外れ、`develop` が `main` にマージされ、ベータ版のプロジェクトはベータ版テンプレートを外せるようになります。[リリースワークフロー](../.github/workflows/release.yml) は、`main` への PR を、`CHANGELOG.md` の先頭セクションが単純な `## X.Y.Z` であり、どのバージョンにもプレリリースサフィックスが付いておらず、`vX.Y.Z` タグがまだ存在しない場合を除いて失敗させます。マージ後は `vX.Y.Z` タグを作成し、そのセクションをリリースノートとして GitHub リリースを公開します。

コミットを固定するには、各ツールが受け付ける箇所で 40 文字の完全な SHA を使います：

- **Claude Code** の v2.1.324 より前のバージョンは、マーケットプレイス URL の `#…` サフィックスとマーケットプレイスの `ref` をブランチまたはタグとしてのみ解釈するため、そこに SHA を指定すると存在しないブランチとして失敗します（v2.1.324 以降はマーケットプレイスの `ref` として完全な SHA も受け付けます）。古いバージョンに対応するには、代わりに独自のマーケットプレイス（たとえばプロジェクトの `.claude-plugin/marketplace.json`）で、`git-subdir` ソースとその `sha` を使って各プラグインを固定します：

  ```json
  { "name": "dev-skills", "source": { "source": "git-subdir", "url": "https://github.com/amyteq/gitmunk.git", "path": "plugins/dev-skills", "sha": "<full commit SHA>" } }
  ```

- **Codex** はマーケットプレイスの ref として SHA を受け付けます：`codex plugin marketplace add amyteq/gitmunk --ref <full commit SHA>`。
- **Ask ワークフロー** は、呼び出し元の `uses:` で `@` の後に SHA を指定できます。

## よくある質問

**なぜマーケットプレイス名が 2 つあるのですか？** Claude Code はマシン全体でマーケットプレイス名ごとに 1 つのソースしか登録しないため、1 つの名前でユーザー設定では `main` を、プロジェクトでは `develop` を提供することはできません。安定版は `gitmunk`（`main` から）、ベータ版は `gitmunk-beta`（`develop` から）です。[チャンネル](#チャンネル) を参照してください。

**スキル名が別のプラグインのスキルと衝突します。どう呼び出せばよいですか？** プラグインのプレフィックスを付けます。Claude Code では `/dev-skills:dev-review-pr` です。Codex は常にプラグインのスキルを `dev-skills:dev-review-pr` のようにプレフィックス付きで一覧表示します。

**なぜ Codex では `npm ci --prefix` が必要なのですか？** `dev-skills` のヘルパースクリプトには、バージョンが固定された npm パッケージが 1 つ必要です。Claude Code はプラグインの `package-lock.json` からそれをインストールしますが、Codex はプラグインの npm 依存関係をインストールしないため、インストールまたは更新の後に一度 `npm ci --prefix "<installed plugin folder>"` を実行してください。

**バージョンを固定するにはどうすればよいですか？** 各ツールが受け付ける箇所で 40 文字の完全なコミット SHA を使います。Claude Code、Codex、Ask ワークフローそれぞれの書き方は [バージョン](#バージョン) に記載しています。各リリースには `vX.Y.Z` タグも付けられます。

**Ask ワークフローはデフォルトで有効ですか？** いいえ。0.3.0 以降、エージェントは対応するリポジトリ変数（`CLAUDE_ACTION_ENABLED` または `CODEX_ACTION_ENABLED`）が `true` で、かつシークレットがワークフローに渡される場合にのみ実行されます。それ以外の場合、実行はルーティングの段階で停止し、その理由がログに記録されます。[リポジトリのセットアップ](../scripts/github-agent/README.md#set-up-a-repository) を参照してください。

## 計測結果

> **プレースホルダー：** まだ計測結果はありません。結果が揃い次第、このセクションでスキルを使った場合と使わない場合の実行結果を示します。

## 導入前と導入後

> **プレースホルダー：** 実例はまだありません。このセクションでは、1 つのタスクをスキルを使った場合と使わない場合で比較して示す予定です。

## gitmunk を使ったプロジェクト

> **プレースホルダー：** 公開プロジェクトはまだ掲載されていません。gitmunk を使っていて掲載を希望するプロジェクトをここに追加します。

## ドキュメント

| ドキュメント | 内容 |
| --- | --- |
| [インストールガイド](../docs/install.md) | Claude Code と Codex での gitmunk のインストール、更新、削除：インストーラー、スコープ、チャンネル、テンプレート、トラブルシューティング |
| [CHANGELOG.md](../CHANGELOG.md) | 各リリースの変更点と移行に関する注意事項 |
| [AGENTS.md](../AGENTS.md) | このリポジトリで作業する際のルール |
| [`dev-skills`](../plugins/dev-skills/README.md) | 8 つのスキル、それぞれの権限とセットアップ |
| [作業モデル](../plugins/dev-skills/references/work-model.md) | `dev-analyse-rp` と `dev-refine-story` が従う `ft-sty` の feat・story モデル |
| [`dev-hooks`](../plugins/dev-hooks/README.md) | 各フック、それが拒否または確認する操作、失敗時のポリシー |
| [Ask エージェント](../scripts/github-agent/README.md) | リポジトリでの Ask ワークフローのセットアップ |
| [`templates/claude/`](../templates/claude) | 安定版チャンネルとベータ版チャンネルの設定テンプレート |
| [`templates/github/`](../templates/github) | Ask の呼び出し元ワークフロー |

## 開発

```bash
node scripts/sync-shared.mjs            # copy shared/ helpers into each plugin
node scripts/sync-shared.mjs --check    # CI: fail on drift
(cd plugins/dev-skills && npm ci && npm test)
python3 -m unittest discover -s plugins/dev-hooks/tests
python3 -m unittest discover -s scripts/github-agent/tests
python3 -m unittest discover -s scripts/release/tests
```

共有ヘルパーは `shared/` でのみ編集してください。各プラグインはそれぞれ独立したキャッシュとしてインストールされるため、プラグインには同期されたコピーが含まれています。

## コントリビュート

変更はベータチャンネルである `develop` に取り込まれ、`main` は `develop` からのリリースのみを受け取ります。タスクブランチで作業し、`develop` に向けて焦点を絞った PR を作成してください。[AGENTS.md](../AGENTS.md) のルールに従ってください：公開できる内容のみを扱うこと、共有ヘルパーは `shared/` でのみ編集すること、利用者に届けるべきプラグインの変更ではそのプラグインのバージョンを `X.Y.Z-beta.N` として上げ、`CHANGELOG.md` にエントリーを追加すること。プッシュする前に [開発](#開発) のチェックを実行してください。

## スポンサー

スポンサーシップは、[`.github/FUNDING.yml`](../.github/FUNDING.yml) に記載されている `amyteq` Organization の GitHub Sponsors を通じて行われます。リポジトリの Sponsor ボタンは、Organization の Sponsors プロフィールが承認されると機能します。それまではどこにもリンクしません。

## スター履歴

<a href="https://www.star-history.com/?repos=amyteq%2Fgitmunk&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date&amp;theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date" />
    <img alt="gitmunk のスター履歴" src="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date" />
  </picture>
</a>

## ライセンス

[MIT](../LICENSE)
