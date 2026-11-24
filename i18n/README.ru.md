# 🐿️ gitmunk

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [العربية](README.ar.md) · **[Русский](README.ru.md)**

Эта страница переведена с английского README на коммите [5ed4276](https://github.com/amyteq/gitmunk/blob/5ed427694c220c82f7394498f1d8067f0d31f5d5/README.md) и может отставать от него.

[![CI](https://github.com/amyteq/gitmunk/actions/workflows/ci.yml/badge.svg)](https://github.com/amyteq/gitmunk/actions/workflows/ci.yml)
[![Последний релиз](https://img.shields.io/github/v/release/amyteq/gitmunk?style=flat-square&label=release)](https://github.com/amyteq/gitmunk/releases)
[![Лицензия MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](../LICENSE)

Карманный набор навыков для агентов, защитных хуков и рабочих процессов GitHub для небольших команд, которые работают с Claude Code и Codex. Один маркетплейс, два плагина; устанавливайте только то, что нужно проекту.

| Плагин | Что добавляет |
| --- | --- |
| [`dev-skills`](../plugins/dev-skills) | Восемь навыков агента для работы с GitHub: доработка issue до рабочих заданий, ревью и слияние PR, объяснение ожидающих решений, сжатие длинных обсуждений, отслеживание серий обсуждений и планирование фич и историй. См. [Навыки](#навыки). |
| [`dev-hooks`](../plugins/dev-hooks) | Защитные хуки и хуки аудита для Claude Code |

GitHub Actions: переиспользуемый рабочий процесс «Ask agent» ([`.github/workflows/ask-agent.yml`](../.github/workflows/ask-agent.yml)) позволяет Claude Code или Codex отвечать на упоминания в issue, PR и обсуждениях. Тонкие вызывающие рабочие процессы скопируйте из [`templates/github/`](../templates/github).

## Быстрый старт

1. Установите плагины, как описано в разделе [Установка](#установка).
2. В локальной копии репозитория GitHub, выполнив вход в GitHub CLI (`gh`), превратите issue в рабочее задание:

   ```text
   /dev-refine-issue 42
   ```

   В Codex вызывайте его как `$dev-refine-issue 42`. Навык читает issue и файл `AGENTS.md` репозитория, затем публикует комментарий с задачей, критериями приёмки и готовыми к копированию промптами запуска. Сам issue он не реализует.

## Как это работает

- **Один маркетплейс, два плагина.** Этот репозиторий — маркетплейс плагинов ([`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)), в котором перечислены `dev-skills` и `dev-hooks`. Claude Code и Codex устанавливают каждый плагин в собственный кеш плагинов, поэтому в ваш репозиторий ничего не копируется.
- **Навыки** — это инструкции с небольшими вспомогательными скриптами на Node.js. Агент загружает навык, когда вы вызываете его по имени, читает `AGENTS.md` и `CLAUDE.md` вашего репозитория, чтобы узнать правила проекта, и выполняет только те записи, которые описаны в навыке.
- **Хуки** (`dev-hooks`, только для Claude Code) — это скрипты на Python, которые выполняются до и после вызовов инструментов. Они запрещают деструктивные вызовы и вызовы, читающие секреты, или запрашивают по ним подтверждение, блокируют слияние чужих PR и записывают в журнал события со скрытыми конфиденциальными данными.
- **Рабочий процесс Ask** — переиспользуемый рабочий процесс GitHub Actions, который позволяет Claude Code или Codex отвечать на упоминания `@claude` и `@codex` в issue, PR и обсуждениях. Репозиторий копирует тонкий вызывающий рабочий процесс из [`templates/github/`](../templates/github), и каждый агент запускается, только если его переменная репозитория равна `true` и задан его секрет.
- **Каналы** — это ветки: стабильный канал берётся из `main`, бета — из `develop`, под двумя именами маркетплейса. См. [Версии](#версии).

## Навыки

| Навык | Что делает |
| --- | --- |
| [`dev-refine-issue`](../plugins/dev-skills/skills/dev-refine-issue/SKILL.md) | Дорабатывает существующий issue до ограниченного рабочего задания с наблюдаемыми критериями приёмки, самодостаточным комментарием с задачей и готовыми к копированию промптами запуска. Сам issue никогда не реализует. |
| [`dev-review-pr`](../plugins/dev-skills/skills/dev-review-pr/SKILL.md) | Проводит ограниченные раунды ревью и исправлений PR в независимых сессиях Codex или Claude Code, с решениями по замечаниям, подкреплёнными ссылками на доказательства, и финальным полным ревью перед одобрением. |
| [`dev-merge`](../plugins/dev-skills/skills/dev-merge/SKILL.md) | Выполняет squash-слияние одного проверенного PR по явной просьбе владельца, проверяет итоговое дерево, наводит порядок, публикует итоговый комментарий и обновляет связанные issue и трекеры. Никогда не выполняет слияние по собственной инициативе. |
| [`dev-explain`](../plugins/dev-skills/skills/dev-explain/SKILL.md) | Объясняет ожидающие решения людей по одному issue, PR или обсуждению: контекст, примеры, рекомендация и сравнение вариантов, затем добавляет один комментарий с результатом. Сам ничего не решает. |
| [`dev-compact`](../plugins/dev-skills/skills/dev-compact/SKILL.md) | Сжимает один issue, PR или обсуждение с заданным уровнем: оставляет ключевые пункты в описании, дословно переносит подробности в новые комментарии и добавляет один комментарий с результатом. Области AUTO и критерии приёмки остаются неизменными байт в байт. |
| [`dev-track`](../plugins/dev-skills/skills/dev-track/SKILL.md) | Собирает все необработанные обсуждения одной категории, например протоколы встреч, в обсуждение-трекер этой категории, объединяет их TODO, помечает каждое как обработанное и закрывает его. По умолчанию только готовит черновик и выполняет запись только с `--apply`. |
| [`dev-analyse-rp`](../plugins/dev-skills/skills/dev-analyse-rp/SKILL.md) | Анализирует один пакет запроса (локальный путь, issue или обсуждение) и превращает его в предложение только для планирования: карта историй, срезы поставки, кандидатные единицы работы, граф зависимостей и независимое ревью. Только при явном разрешении открывает один PR с документами feat и story, с метками и отслеживающими issue. |
| [`dev-refine-story`](../plugins/dev-skills/skills/dev-refine-story/SKILL.md) | Сопоставляет историю `STY_<n>` ровно с одним issue на GitHub, затем передаёт работу навыку `dev-refine-issue`. Саму историю никогда не реализует. |

## Установка

Запустите установщик (Node.js 20 или новее). Он спрашивает канал, область установки и агентов, выводит каждый шаг и ничего не меняет, пока вы не подтвердите:

```bash
npx --allow-git=root github:amyteq/gitmunk
```

npm 12 запускает пакет прямо из git-репозитория только с `--allow-git=root`. В [руководстве по установке](../docs/install.md) описаны вопросы и флаги установщика, области установки, бета-канал, шаблоны настроек, обновление, удаление и устранение неполадок.

Чтобы установить вручную:

### Claude Code

```bash
claude plugin marketplace add amyteq/gitmunk#main
claude plugin install dev-skills@gitmunk
claude plugin install dev-hooks@gitmunk      # optional: the guardrail hooks
```

Чтобы поделиться плагинами с командой, вместо этого объедините [`templates/claude/settings.json`](https://github.com/amyteq/gitmunk/blob/5ed427694c220c82f7394498f1d8067f0d31f5d5/templates/claude/settings.json) с файлом `.claude/settings.json` проекта.

### Codex

```bash
codex plugin marketplace add amyteq/gitmunk --ref main
codex plugin add dev-skills@gitmunk
npm ci --prefix "${CODEX_HOME:-$HOME/.codex}/plugins/cache/gitmunk/dev-skills/<version>"
```

Codex не устанавливает npm-зависимости плагинов, поэтому последняя команда устанавливает пакет для вспомогательных скриптов; `<version>` — это версия, которую показывает `codex plugin list`.

## Версии

Каналы — это ветки: `main` — стабильный, `develop` — бета. Чтобы установленные копии обновились, должно измениться поле `version` каждого плагина в `.claude-plugin/plugin.json`. См. [CHANGELOG.md](../CHANGELOG.md).

### Каналы

| Канал | Маркетплейс | Ref | ID плагинов | Шаблон |
| --- | --- | --- | --- | --- |
| Стабильный (по умолчанию) | `gitmunk` | последний коммит ветки `main` | `dev-skills@gitmunk`, `dev-hooks@gitmunk` | [`templates/claude/settings.json`](https://github.com/amyteq/gitmunk/blob/5ed427694c220c82f7394498f1d8067f0d31f5d5/templates/claude/settings.json) |
| Бета | `gitmunk-beta` ([каталог](../channels/beta/.claude-plugin/marketplace.json)) | последний коммит ветки `develop`, версии вида `0.3.0-beta.1` | `dev-skills@gitmunk-beta`, `dev-hooks@gitmunk-beta` | [`templates/claude/settings.beta.json`](https://github.com/amyteq/gitmunk/blob/5ed427694c220c82f7394498f1d8067f0d31f5d5/templates/claude/settings.beta.json) |

Проект переходит на бета-канал, объединив бета-шаблон со своим `.claude/settings.local.json` (только для вас) или `.claude/settings.json` (для всей команды). У двух маркетплейсов разные имена, потому что Claude Code регистрирует один источник на имя маркетплейса для всей машины; бета-шаблон также задаёт стабильным плагинам значение `false`, чтобы установленный на уровне пользователя стабильный канал не загружал в этом проекте те же навыки дважды. У Codex второго канала нет: направьте `ref` в разделе `[marketplaces.gitmunk]` файла `.codex/config.toml` проекта на `develop` вместо `main`. Когда бета становится релизом, версии её плагинов теряют суффикс `-beta.N`, `develop` сливается в `main`, и бета-проекты могут убрать бета-шаблон. [Рабочий процесс релиза](../.github/workflows/release.yml) отклоняет PR в `main`, если верхний раздел `CHANGELOG.md` не является простым `## X.Y.Z`, если какая-либо версия содержит суффикс пре-релиза или если тег `vX.Y.Z` уже существует; после слияния он ставит тег `vX.Y.Z` и публикует релиз на GitHub с этим разделом в качестве примечаний к выпуску.

Чтобы закрепить коммит, используйте полный 40-символьный SHA там, где его принимает соответствующий инструмент:

- **Claude Code** до v2.1.324 читает суффикс `#…` URL маркетплейса, а также `ref` маркетплейса, только как ветку или тег; SHA в этом месте приводит к ошибке об отсутствующей ветке (v2.1.324 и новее также принимают полный SHA как `ref` маркетплейса). Чтобы поддержать более старые версии, закрепляйте вместо этого каждый плагин в собственном маркетплейсе (например, в `.claude-plugin/marketplace.json` проекта) с источником `git-subdir` и его `sha`:

  ```json
  { "name": "dev-skills", "source": { "source": "git-subdir", "url": "https://github.com/amyteq/gitmunk.git", "path": "plugins/dev-skills", "sha": "<full commit SHA>" } }
  ```

- **Codex** принимает SHA как ref маркетплейса: `codex plugin marketplace add amyteq/gitmunk --ref <full commit SHA>`.
- **Рабочий процесс Ask** принимает SHA после `@` в `uses:` вызывающего рабочего процесса.

## Частые вопросы

**Зачем два имени маркетплейса?** Claude Code регистрирует один источник на имя маркетплейса для всей машины, поэтому одно имя не может обслуживать `main` в ваших пользовательских настройках и `develop` в проекте. Стабильный канал — `gitmunk` (из `main`), бета — `gitmunk-beta` (из `develop`). См. [Каналы](#каналы).

**Имя навыка совпадает с навыком другого плагина. Как его вызвать?** Добавьте префикс плагина: `/dev-skills:dev-review-pr` в Claude Code. Codex всегда показывает навыки плагинов с префиксом, как `dev-skills:dev-review-pr`.

**Зачем Codex нужен `npm ci --prefix`?** Вспомогательным скриптам `dev-skills` нужен один npm-пакет с зафиксированной версией. Claude Code устанавливает его по `package-lock.json` плагина, но Codex не устанавливает npm-зависимости плагинов, поэтому один раз после установки или обновления выполните `npm ci --prefix "<installed plugin folder>"`.

**Как закрепить версию?** Используйте полный 40-символьный SHA коммита там, где его принимает соответствующий инструмент; в разделе [Версии](#версии) показан формат для Claude Code, Codex и рабочего процесса Ask. Каждый релиз также помечен тегом `vX.Y.Z`.

**Включены ли рабочие процессы Ask по умолчанию?** Нет. Начиная с 0.3.0 агент запускается, только если его переменная репозитория (`CLAUDE_ACTION_ENABLED` или `CODEX_ACTION_ENABLED`) равна `true` и его секрет доступен рабочему процессу; иначе запуск останавливается на этапе маршрутизации, а причина записывается в журнал. См. [настройку репозитория](../scripts/github-agent/README.md#set-up-a-repository).

## Цифры

> **Заглушка:** измерений пока нет. Когда они появятся, в этом разделе будут результаты запусков с навыками и без них.

## До и после

> **Заглушка:** разобранного примера пока нет. В этом разделе будет показана одна задача, выполненная с навыком и без него.

## Проекты на gitmunk

> **Заглушка:** публичных проектов в списке пока нет. Сюда будут добавлены проекты, которые используют gitmunk и хотят быть упомянуты.

## Документация

| Документ | Что описывает |
| --- | --- |
| [Руководство по установке](../docs/install.md) | Установка, обновление и удаление gitmunk в Claude Code и Codex: установщик, области установки, каналы, шаблоны и устранение неполадок |
| [CHANGELOG.md](../CHANGELOG.md) | Изменения в каждом релизе с примечаниями по миграции |
| [AGENTS.md](../AGENTS.md) | Правила работы в этом репозитории |
| [`dev-skills`](../plugins/dev-skills/README.md) | Восемь навыков, их полномочия и настройка |
| [Модель работы](../plugins/dev-skills/references/work-model.md) | Модель фич и историй `ft-sty`, которой следуют `dev-analyse-rp` и `dev-refine-story` |
| [`dev-hooks`](../plugins/dev-hooks/README.md) | Каждый хук, что он запрещает или о чём запрашивает подтверждение, и его политика при сбоях |
| [Агент Ask](../scripts/github-agent/README.md) | Настройка рабочего процесса Ask в репозитории |
| [`templates/claude/`](../templates/claude) | Шаблоны настроек для стабильного и бета-канала |
| [`templates/github/`](../templates/github) | Вызывающие рабочие процессы Ask |

## Разработка

```bash
node scripts/sync-shared.mjs            # copy shared/ helpers into each plugin
node scripts/sync-shared.mjs --check    # CI: fail on drift
(cd plugins/dev-skills && npm ci && npm test)
python3 -m unittest discover -s plugins/dev-hooks/tests
python3 -m unittest discover -s scripts/github-agent/tests
python3 -m unittest discover -s scripts/release/tests
```

Редактируйте общие вспомогательные скрипты только в `shared/`; плагины содержат синхронизированные копии, потому что каждый плагин устанавливается в собственный кеш.

## Участие в проекте

Изменения попадают в `develop`, бета-канал; `main` получает только релизы из `develop`. Работайте в ветке задачи и открывайте сфокусированный PR в `develop`. Соблюдайте правила из [AGENTS.md](../AGENTS.md): только публичный контент, общие вспомогательные скрипты редактируются только в `shared/`, а изменение плагина, которое должно дойти до пользователей, повышает версию этого плагина до `X.Y.Z-beta.N` и добавляет запись в `CHANGELOG.md`. Перед push выполните проверки из раздела [Разработка](#разработка).

## Спонсоры

Спонсорская поддержка идёт через GitHub Sponsors для организации `amyteq`, указанной в [`.github/FUNDING.yml`](../.github/FUNDING.yml). Кнопка Sponsor в репозитории заработает, когда профиль Sponsors организации будет одобрен; до тех пор она никуда не ведёт.

## История звёзд

<a href="https://www.star-history.com/?repos=amyteq%2Fgitmunk&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date&amp;theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date" />
    <img alt="История звёзд gitmunk" src="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date" />
  </picture>
</a>

## Лицензия

[MIT](../LICENSE)
