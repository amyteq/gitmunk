# 🐿️ gitmunk

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · **[Français](README.fr.md)** · [العربية](README.ar.md) · [Русский](README.ru.md)

Cette page est traduite du README anglais au commit [5ed4276](https://github.com/amyteq/gitmunk/blob/5ed427694c220c82f7394498f1d8067f0d31f5d5/README.md) et peut être en retard sur celui-ci.

[![CI](https://github.com/amyteq/gitmunk/actions/workflows/ci.yml/badge.svg)](https://github.com/amyteq/gitmunk/actions/workflows/ci.yml)
[![Dernière release](https://img.shields.io/github/v/release/amyteq/gitmunk?style=flat-square&label=release)](https://github.com/amyteq/gitmunk/releases)
[![Licence MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](../LICENSE)

Une boîte à outils de poche réunissant des compétences d'agent, des hooks garde-fous et des workflows GitHub pour les petites équipes qui travaillent avec Claude Code et Codex. Une marketplace, deux plugins ; n'installez que ce dont un projet a besoin.

| Plugin | Ce qu'il apporte |
| --- | --- |
| [`dev-skills`](../plugins/dev-skills) | Huit compétences d'agent pour le travail sur GitHub : affiner des issues en ordres de travail, relire et fusionner des PR, expliquer les décisions en attente, condenser les longs fils, suivre des séries de discussions, et planifier des features et des stories. Voir [Compétences](#compétences). |
| [`dev-hooks`](../plugins/dev-hooks) | Hooks garde-fous et d'audit pour Claude Code |

GitHub Actions : un workflow réutilisable « Ask agent » ([`.github/workflows/ask-agent.yml`](../.github/workflows/ask-agent.yml)) permet à Claude Code ou à Codex de répondre aux mentions dans les issues, les PR et les discussions. Copiez les appelants minimaux depuis [`templates/github/`](../templates/github).

## Démarrage rapide

1. Installez les plugins comme indiqué dans [Installation](#installation).
2. Dans une copie de travail d'un dépôt GitHub, avec GitHub CLI (`gh`) authentifié, transformez une issue en ordre de travail :

   ```text
   /dev-refine-issue 42
   ```

   Dans Codex, appelez-la sous la forme `$dev-refine-issue 42`. La compétence lit l'issue et le fichier `AGENTS.md` du dépôt, puis publie un commentaire de tâche avec des critères d'acceptation et des prompts de lancement à copier. Elle n'implémente pas l'issue.

## Fonctionnement

- **Une marketplace, deux plugins.** Ce dépôt est une marketplace de plugins ([`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)) qui répertorie `dev-skills` et `dev-hooks`. Claude Code et Codex installent chaque plugin dans leur propre cache de plugins ; rien n'est donc copié dans votre dépôt.
- **Les compétences** sont des instructions accompagnées de petits utilitaires Node.js. L'agent en charge une lorsque vous l'appelez par son nom, lit les fichiers `AGENTS.md` et `CLAUDE.md` de votre dépôt pour connaître les règles du projet, et n'effectue que les écritures que la compétence décrit.
- **Les hooks** (`dev-hooks`, Claude Code uniquement) sont des scripts Python qui s'exécutent autour des appels d'outils. Ils refusent ou soumettent à confirmation les appels destructeurs et ceux qui lisent des secrets, bloquent la fusion de la PR de quelqu'un d'autre et journalisent des événements expurgés.
- **Le workflow Ask** est un workflow GitHub Actions réutilisable qui permet à Claude Code ou à Codex de répondre aux mentions `@claude` et `@codex` dans les issues, les PR et les discussions. Un dépôt copie un appelant minimal depuis [`templates/github/`](../templates/github), et chaque agent ne s'exécute que lorsque sa variable de dépôt vaut `true` et que son secret est défini.
- **Les canaux** sont des branches : le canal stable provient de `main` et le canal bêta de `develop`, sous deux noms de marketplace. Voir [Versions](#versions).

## Compétences

| Compétence | Ce qu'elle fait |
| --- | --- |
| [`dev-refine-issue`](../plugins/dev-skills/skills/dev-refine-issue/SKILL.md) | Affine une issue existante en un ordre de travail borné, avec des critères d'acceptation observables, un commentaire de tâche autonome et des prompts de lancement à copier. Elle n'implémente jamais l'issue. |
| [`dev-review-pr`](../plugins/dev-skills/skills/dev-review-pr/SKILL.md) | Mène des cycles bornés de revue et de correction de PR avec des sessions Codex ou Claude Code indépendantes, des décisions de traitement étayées par des preuves et une revue complète finale avant approbation. |
| [`dev-merge`](../plugins/dev-skills/skills/dev-merge/SKILL.md) | Fusionne par squash une PR relue lorsque le propriétaire le demande explicitement, vérifie l'arbre fusionné, fait le ménage, publie un commentaire de clôture et met à jour les issues et les suivis liés. Elle ne fusionne jamais de sa propre initiative. |
| [`dev-explain`](../plugins/dev-skills/skills/dev-explain/SKILL.md) | Explique les décisions humaines en attente sur une issue, une PR ou une discussion, avec le contexte, des exemples, une recommandation et une comparaison des options, puis ajoute un commentaire de résultat. Elle ne décide rien. |
| [`dev-compact`](../plugins/dev-skills/skills/dev-compact/SKILL.md) | Condense une issue, une PR ou une discussion selon un niveau : garde les points clés dans le corps, déplace les détails mot pour mot dans de nouveaux commentaires et ajoute un commentaire de résultat. Les régions AUTO et les critères d'acceptation restent identiques à l'octet près. |
| [`dev-track`](../plugins/dev-skills/skills/dev-track/SKILL.md) | Rassemble toutes les discussions non traitées d'une catégorie, comme des comptes rendus de réunion, dans la discussion de suivi de cette catégorie, fusionne leurs TODO, marque chacune comme traitée et la ferme. Par défaut, elle produit des brouillons et n'écrit qu'avec `--apply`. |
| [`dev-analyse-rp`](../plugins/dev-skills/skills/dev-analyse-rp/SKILL.md) | Analyse un dossier de demande (un chemin local, une issue ou une discussion) pour en tirer une proposition limitée à la planification, avec une story map, des tranches de livraison, des unités candidates, un graphe de dépendances et une revue indépendante. Ce n'est que sur autorisation explicite qu'elle ouvre une PR de documents de feat et de story, avec des labels et des issues de suivi. |
| [`dev-refine-story`](../plugins/dev-skills/skills/dev-refine-story/SKILL.md) | Associe une story `STY_<n>` à exactement une issue GitHub, puis passe la main à `dev-refine-issue`. Elle n'implémente jamais la story. |

## Installation

Lancez le programme d'installation (Node.js 20 ou ultérieur). Il demande le canal, la portée et les agents, affiche chaque étape et ne modifie rien tant que vous n'avez pas confirmé :

```bash
npx --allow-git=root github:amyteq/gitmunk
```

npm 12 n'exécute un paquet directement depuis un dépôt git qu'avec `--allow-git=root`. Le [guide d'installation](../docs/install.md) couvre les questions et les options du programme d'installation, les portées, le canal bêta, les modèles de paramètres, la mise à jour, la désinstallation et le dépannage.

Pour installer manuellement à la place :

### Claude Code

```bash
claude plugin marketplace add amyteq/gitmunk#main
claude plugin install dev-skills@gitmunk
claude plugin install dev-hooks@gitmunk      # optional: the guardrail hooks
```

Pour partager les plugins avec une équipe, fusionnez plutôt [`templates/claude/settings.json`](https://github.com/amyteq/gitmunk/blob/5ed427694c220c82f7394498f1d8067f0d31f5d5/templates/claude/settings.json) dans le fichier `.claude/settings.json` du projet.

### Codex

```bash
codex plugin marketplace add amyteq/gitmunk --ref main
codex plugin add dev-skills@gitmunk
npm ci --prefix "${CODEX_HOME:-$HOME/.codex}/plugins/cache/gitmunk/dev-skills/<version>"
```

Codex n'installe pas les dépendances npm des plugins ; la dernière commande installe donc le paquet des utilitaires. `<version>` est celle qu'affiche `codex plugin list`.

## Versions

Les canaux sont des branches : `main` est stable et `develop` est bêta. Le champ `version` de chaque plugin dans `.claude-plugin/plugin.json` doit changer pour que les copies installées se mettent à jour. Voir [CHANGELOG.md](../CHANGELOG.md).

### Canaux

| Canal | Marketplace | Ref | Identifiants de plugin | Modèle |
| --- | --- | --- | --- | --- |
| Stable (par défaut) | `gitmunk` | la tête de `main` | `dev-skills@gitmunk`, `dev-hooks@gitmunk` | [`templates/claude/settings.json`](../templates/claude/settings.json) |
| Bêta | `gitmunk-beta` ([catalogue](../channels/beta/.claude-plugin/marketplace.json)) | la tête de `develop`, versions du type `0.3.0-beta.1` | `dev-skills@gitmunk-beta`, `dev-hooks@gitmunk-beta` | [`templates/claude/settings.beta.json`](../templates/claude/settings.beta.json) |

Un projet passe au canal bêta en fusionnant le modèle bêta dans son `.claude/settings.local.json` (pour vous seul) ou dans son `.claude/settings.json` (pour toute l'équipe). Les deux marketplaces portent des noms différents parce que Claude Code enregistre une seule source par nom de marketplace pour toute la machine ; le modèle bêta met aussi les plugins stables à `false`, afin qu'une installation stable au niveau utilisateur ne charge pas deux fois les mêmes compétences dans ce projet. Codex n'a pas de second canal : faites pointer la `ref` de `[marketplaces.gitmunk]` dans le `.codex/config.toml` du projet vers `develop` au lieu de `main`. Lorsqu'une bêta devient une release, les versions de ses plugins perdent le suffixe `-beta.N`, `develop` est fusionnée dans `main`, et les projets en bêta peuvent retirer le modèle bêta. Le [workflow de release](../.github/workflows/release.yml) fait échouer une PR vers `main` sauf si la première section de `CHANGELOG.md` est un simple `## X.Y.Z`, qu'aucune version ne porte de suffixe de pré-release et que `vX.Y.Z` n'est pas encore tagué ; la fusion crée alors le tag `vX.Y.Z` et publie une release GitHub avec cette section comme notes.

Pour épingler un commit, utilisez le SHA complet de 40 caractères là où chaque outil en accepte un :

- **Claude Code** avant la v2.1.324 interprète le suffixe `#…` d'une URL de marketplace, ainsi qu'une `ref` de marketplace, uniquement comme une branche ou un tag ; un SHA à cet endroit échoue comme une branche introuvable (la v2.1.324 et les versions ultérieures acceptent aussi un SHA complet comme `ref` de marketplace). Pour prendre en charge les versions plus anciennes, épinglez plutôt chaque plugin, dans une marketplace à vous (par exemple un `.claude-plugin/marketplace.json` de projet), avec une source `git-subdir` et son `sha` :

  ```json
  { "name": "dev-skills", "source": { "source": "git-subdir", "url": "https://github.com/amyteq/gitmunk.git", "path": "plugins/dev-skills", "sha": "<full commit SHA>" } }
  ```

- **Codex** accepte un SHA comme ref de marketplace : `codex plugin marketplace add amyteq/gitmunk --ref <full commit SHA>`.
- **Le workflow Ask** accepte un SHA après `@` dans le `uses:` de l'appelant.

## FAQ

**Pourquoi y a-t-il deux noms de marketplace ?** Claude Code enregistre une seule source par nom de marketplace pour toute la machine ; un même nom ne peut donc pas servir `main` dans vos paramètres utilisateur et `develop` dans un projet. Le canal stable est `gitmunk` (depuis `main`) et le canal bêta est `gitmunk-beta` (depuis `develop`). Voir [Canaux](#canaux).

**Le nom d'une compétence entre en conflit avec celui d'une compétence d'un autre plugin. Comment l'appeler ?** Ajoutez le préfixe du plugin : `/dev-skills:dev-review-pr` dans Claude Code. Codex liste toujours les compétences de plugin avec le préfixe, sous la forme `dev-skills:dev-review-pr`.

**Pourquoi Codex a-t-il besoin de `npm ci --prefix` ?** Les scripts utilitaires de `dev-skills` nécessitent un paquet npm verrouillé. Claude Code l'installe à partir du `package-lock.json` du plugin, mais Codex n'installe pas les dépendances npm des plugins ; exécutez donc `npm ci --prefix "<installed plugin folder>"` une fois après chaque installation ou mise à jour.

**Comment épingler une version ?** Utilisez un SHA de commit complet de 40 caractères là où chaque outil en accepte un ; [Versions](#versions) montre la forme à employer pour Claude Code, Codex et le workflow Ask. Chaque release porte aussi le tag `vX.Y.Z`.

**Les workflows Ask sont-ils activés par défaut ?** Non. Depuis la 0.3.0, un agent ne s'exécute que lorsque sa variable de dépôt (`CLAUDE_ACTION_ENABLED` ou `CODEX_ACTION_ENABLED`) vaut `true` et que son secret parvient au workflow ; sinon, l'exécution s'arrête à l'étape de routage, avec la raison dans le journal. Voir [configurer un dépôt](../scripts/github-agent/README.md#set-up-a-repository).

## Chiffres

> **Espace réservé :** aucune mesure pour l'instant. Cette section présentera les résultats d'exécutions avec et sans les compétences dès qu'il y en aura.

## Avant / après

> **Espace réservé :** aucun exemple concret pour l'instant. Cette section montrera une même tâche réalisée avec et sans une compétence.

## Construit avec gitmunk

> **Espace réservé :** aucun projet public n'est encore répertorié. Les projets qui utilisent gitmunk et souhaitent être cités seront ajoutés ici.

## Documentation

| Document | Contenu |
| --- | --- |
| [Guide d'installation](../docs/install.md) | Installer, mettre à jour et supprimer gitmunk dans Claude Code et Codex : le programme d'installation, les portées, les canaux, les modèles et le dépannage |
| [CHANGELOG.md](../CHANGELOG.md) | Les changements de chaque release, avec des notes de migration |
| [AGENTS.md](../AGENTS.md) | Les règles pour travailler dans ce dépôt |
| [`dev-skills`](../plugins/dev-skills/README.md) | Les huit compétences, leur périmètre d'autorité et leur configuration |
| [Modèle de travail](../plugins/dev-skills/references/work-model.md) | Le modèle de feats et de stories `ft-sty` que suivent `dev-analyse-rp` et `dev-refine-story` |
| [`dev-hooks`](../plugins/dev-hooks/README.md) | Chaque hook, ce qu'il refuse ou soumet à confirmation, et sa politique en cas d'échec |
| [Ask agent](../scripts/github-agent/README.md) | Mettre en place le workflow Ask dans un dépôt |
| [`templates/claude/`](../templates/claude) | Les modèles de paramètres pour les canaux stable et bêta |
| [`templates/github/`](../templates/github) | Les workflows appelants Ask |

## Développement

```bash
node scripts/sync-shared.mjs            # copy shared/ helpers into each plugin
node scripts/sync-shared.mjs --check    # CI: fail on drift
(cd plugins/dev-skills && npm ci && npm test)
python3 -m unittest discover -s plugins/dev-hooks/tests
python3 -m unittest discover -s scripts/github-agent/tests
python3 -m unittest discover -s scripts/release/tests
```

Ne modifiez les utilitaires partagés que dans `shared/` ; les plugins en portent des copies synchronisées, car chaque plugin est installé dans son propre cache.

## Contribuer

Les changements arrivent sur `develop`, le canal bêta ; `main` ne reçoit que des releases issues de `develop`. Travaillez sur une branche de tâche et ouvrez une PR ciblée vers `develop`. Suivez les règles de [AGENTS.md](../AGENTS.md) : contenu public uniquement, utilitaires partagés modifiés uniquement dans `shared/`, et toute modification de plugin que les consommateurs doivent recevoir incrémente la version de ce plugin sous la forme `X.Y.Z-beta.N`, avec une entrée dans `CHANGELOG.md`. Lancez les vérifications de [Développement](#développement) avant de pousser.

## Parrainage

Le parrainage passe par GitHub Sponsors pour l'organisation `amyteq`, que nomme [`.github/FUNDING.yml`](../.github/FUNDING.yml). Le bouton Sponsor du dépôt fonctionne dès que le profil Sponsors de l'organisation est approuvé ; d'ici là, il ne mène nulle part.

## Historique des étoiles

<a href="https://www.star-history.com/?repos=amyteq%2Fgitmunk&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date&amp;theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date" />
    <img alt="Historique des étoiles de gitmunk" src="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date" />
  </picture>
</a>

## Licence

[MIT](../LICENSE)
