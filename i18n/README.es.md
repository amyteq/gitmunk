# 🐿️ gitmunk

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **[Español](README.es.md)** · [Français](README.fr.md) · [العربية](README.ar.md) · [Русский](README.ru.md)

Esta página se tradujo del README en inglés en el commit [5ed4276](https://github.com/amyteq/gitmunk/blob/5ed427694c220c82f7394498f1d8067f0d31f5d5/README.md) y puede ir por detrás de él.

[![CI](https://github.com/amyteq/gitmunk/actions/workflows/ci.yml/badge.svg)](https://github.com/amyteq/gitmunk/actions/workflows/ci.yml)
[![Última release](https://img.shields.io/github/v/release/amyteq/gitmunk?style=flat-square&label=release)](https://github.com/amyteq/gitmunk/releases)
[![Licencia MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](../LICENSE)

Un kit de herramientas de bolsillo con skills de agente, hooks de salvaguarda y flujos de trabajo de GitHub para equipos pequeños que trabajan con Claude Code y Codex. Un marketplace, dos plugins; instala solo lo que necesite cada proyecto.

| Plugin | Qué añade |
| --- | --- |
| [`dev-skills`](../plugins/dev-skills) | Ocho skills de agente para el trabajo en GitHub: refinar issues en órdenes de trabajo, revisar y fusionar PR, explicar decisiones pendientes, compactar hilos largos, seguir series de discusiones y planificar feats e historias. Consulta [Skills](#skills). |
| [`dev-hooks`](../plugins/dev-hooks) | Hooks de salvaguarda y auditoría para Claude Code |

GitHub Actions: un flujo de trabajo reutilizable "Ask agent" ([`.github/workflows/ask-agent.yml`](../.github/workflows/ask-agent.yml)) permite que Claude Code o Codex respondan a menciones en issues, PR y discusiones. Copia los llamadores ligeros desde [`templates/github/`](../templates/github).

## Inicio rápido

1. Instala los plugins como se indica en [Instalación](#instalación).
2. En una copia local de un repositorio de GitHub, con la GitHub CLI (`gh`) con la sesión iniciada, convierte un issue en una orden de trabajo:

   ```text
   /dev-refine-issue 42
   ```

   En Codex, invócala como `$dev-refine-issue 42`. La skill lee el issue y el `AGENTS.md` del repositorio y después publica un comentario de tarea con criterios de aceptación y prompts de lanzamiento listos para copiar. No implementa el issue.

## Cómo funciona

- **Un marketplace, dos plugins.** Este repositorio es un marketplace de plugins ([`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)) que incluye `dev-skills` y `dev-hooks`. Claude Code y Codex instalan cada plugin en su propia caché de plugins, así que no se copia nada en tu repositorio.
- **Las skills** son instrucciones con pequeños helpers de Node.js. El agente carga una cuando la invocas por su nombre, lee el `AGENTS.md` y el `CLAUDE.md` de tu repositorio para conocer las reglas del proyecto y solo realiza las escrituras que describe la skill.
- **Los hooks** (`dev-hooks`, solo Claude Code) son scripts de Python que se ejecutan alrededor de las llamadas a herramientas. Deniegan o piden confirmación ante llamadas destructivas o que leen secretos, bloquean la fusión del PR de otra persona y registran eventos con los datos sensibles ocultos.
- **El flujo Ask** es un flujo de trabajo reutilizable de GitHub Actions que permite que Claude Code o Codex respondan a menciones `@claude` y `@codex` en issues, PR y discusiones. Un repositorio copia un llamador ligero desde [`templates/github/`](../templates/github), y cada agente se ejecuta solo cuando su variable de repositorio es `true` y su secreto está configurado.
- **Los canales** son ramas: el estable sale de `main` y el beta de `develop`, con dos nombres de marketplace distintos. Consulta [Versiones](#versiones).

## Skills

| Skill | Qué hace |
| --- | --- |
| [`dev-refine-issue`](../plugins/dev-skills/skills/dev-refine-issue/SKILL.md) | Refina un issue existente en una orden de trabajo acotada con criterios de aceptación observables, un comentario de tarea autónomo y prompts de lanzamiento listos para copiar. Nunca implementa el issue. |
| [`dev-review-pr`](../plugins/dev-skills/skills/dev-review-pr/SKILL.md) | Ejecuta rondas acotadas de revisión y corrección de PR con sesiones independientes de Codex o Claude Code, resoluciones respaldadas por evidencias y una revisión completa final antes de la aprobación. |
| [`dev-merge`](../plugins/dev-skills/skills/dev-merge/SKILL.md) | Fusiona con squash un PR revisado cuando el propietario lo pide explícitamente, verifica el árbol fusionado, hace limpieza, publica un comentario de cierre y actualiza los issues y trackers vinculados. Nunca fusiona por iniciativa propia. |
| [`dev-explain`](../plugins/dev-skills/skills/dev-explain/SKILL.md) | Explica las decisiones humanas pendientes de un issue, PR o discusión, con contexto, ejemplos, una recomendación y la comparación de las opciones, y después añade un comentario de resultado. No decide nada. |
| [`dev-compact`](../plugins/dev-skills/skills/dev-compact/SKILL.md) | Compacta un issue, PR o discusión según un nivel: conserva los puntos clave en el cuerpo, mueve los detalles literalmente a comentarios nuevos y añade un comentario de resultado. Las regiones AUTO y los criterios de aceptación se mantienen idénticos byte a byte. |
| [`dev-track`](../plugins/dev-skills/skills/dev-track/SKILL.md) | Recopila todas las discusiones sin procesar de una categoría, como las actas de reuniones, en la discusión tracker de esa categoría, combina sus TODO, marca cada una como procesada y la cierra. Por defecto solo prepara un borrador y escribe únicamente con `--apply`. |
| [`dev-analyse-rp`](../plugins/dev-skills/skills/dev-analyse-rp/SKILL.md) | Analiza un request pack (una ruta local, un issue o una discusión) y lo convierte en una propuesta solo de planificación con un mapa de historias, porciones de entrega, unidades candidatas, un grafo de dependencias y una revisión independiente. Solo con autorización explícita abre un PR con documentos de feats e historias, junto con etiquetas e issues de seguimiento. |
| [`dev-refine-story`](../plugins/dev-skills/skills/dev-refine-story/SKILL.md) | Resuelve una historia `STY_<n>` en exactamente un issue de GitHub y después la pasa a `dev-refine-issue`. Nunca implementa la historia. |

## Instalación

Ejecuta el instalador (Node.js 20 o posterior). Pregunta por el canal, el ámbito y los agentes, muestra cada paso y no cambia nada hasta que confirmas:

```bash
npx --allow-git=root github:amyteq/gitmunk
```

npm 12 solo ejecuta un paquete directamente desde un repositorio git con `--allow-git=root`. La [guía de instalación](../docs/install.md) cubre las preguntas y opciones del instalador, los ámbitos, el canal beta, las plantillas de configuración, la actualización, la desinstalación y la resolución de problemas.

Para instalar a mano:

### Claude Code

```bash
claude plugin marketplace add amyteq/gitmunk#main
claude plugin install dev-skills@gitmunk
claude plugin install dev-hooks@gitmunk      # optional: the guardrail hooks
```

Para compartir los plugins con un equipo, combina en su lugar [`templates/claude/settings.json`](../templates/claude/settings.json) con el `.claude/settings.json` del proyecto.

### Codex

```bash
codex plugin marketplace add amyteq/gitmunk --ref main
codex plugin add dev-skills@gitmunk
npm ci --prefix "${CODEX_HOME:-$HOME/.codex}/plugins/cache/gitmunk/dev-skills/<version>"
```

Codex no instala las dependencias npm de los plugins, así que el último comando instala el paquete de los helpers; `<version>` es la que muestra `codex plugin list`.

## Versiones

Los canales son ramas: `main` es el estable y `develop` el beta. El `version` de cada plugin en `.claude-plugin/plugin.json` tiene que cambiar para que se actualicen las copias instaladas. Consulta [CHANGELOG.md](../CHANGELOG.md).

### Canales

| Canal | Marketplace | Ref | IDs de plugin | Plantilla |
| --- | --- | --- | --- | --- |
| Estable (predeterminado) | `gitmunk` | el último commit de `main` | `dev-skills@gitmunk`, `dev-hooks@gitmunk` | [`templates/claude/settings.json`](../templates/claude/settings.json) |
| Beta | `gitmunk-beta` ([catálogo](../channels/beta/.claude-plugin/marketplace.json)) | el último commit de `develop`, con versiones como `0.3.0-beta.1` | `dev-skills@gitmunk-beta`, `dev-hooks@gitmunk-beta` | [`templates/claude/settings.beta.json`](../templates/claude/settings.beta.json) |

Un proyecto se apunta al canal beta combinando la plantilla beta con su `.claude/settings.local.json` (solo para ti) o con su `.claude/settings.json` (para todo el equipo). Los dos marketplaces tienen nombres distintos porque Claude Code registra una sola fuente por nombre de marketplace para toda la máquina; la plantilla beta además pone los plugins estables a `false`, para que una instalación estable a nivel de usuario no cargue las mismas skills dos veces en ese proyecto. Codex no tiene un segundo canal: apunta el `ref` de `[marketplaces.gitmunk]` del proyecto en `.codex/config.toml` a `develop` en lugar de a `main`. Cuando una beta se convierte en release, las versiones de sus plugins pierden el sufijo `-beta.N`, `develop` se fusiona en `main` y los proyectos beta pueden retirar la plantilla beta. El [flujo de trabajo de release](../.github/workflows/release.yml) hace fallar un PR hacia `main` salvo que la primera sección de `CHANGELOG.md` sea un `## X.Y.Z` sin más, ninguna versión lleve sufijo de prerelease y `vX.Y.Z` aún no exista como etiqueta; después, la fusión crea la etiqueta `vX.Y.Z` y publica una release de GitHub con esa sección como notas.

Para fijar un commit, usa el SHA completo de 40 caracteres allí donde cada herramienta lo admita:

- **Claude Code** anterior a v2.1.324 interpreta el sufijo `#…` de una URL de marketplace, y el `ref` de un marketplace, solo como rama o etiqueta; un SHA en ese lugar falla como rama inexistente (v2.1.324 y posteriores también aceptan un SHA completo como `ref` de marketplace). Para admitir versiones anteriores, fija en su lugar cada plugin, en un marketplace propio (por ejemplo, un `.claude-plugin/marketplace.json` del proyecto), con una fuente `git-subdir` y su `sha`:

  ```json
  { "name": "dev-skills", "source": { "source": "git-subdir", "url": "https://github.com/amyteq/gitmunk.git", "path": "plugins/dev-skills", "sha": "<full commit SHA>" } }
  ```

- **Codex** acepta un SHA como ref del marketplace: `codex plugin marketplace add amyteq/gitmunk --ref <full commit SHA>`.
- **El flujo Ask** acepta un SHA después de `@` en el `uses:` del llamador.

## Preguntas frecuentes

**¿Por qué hay dos nombres de marketplace?** Claude Code registra una sola fuente por nombre de marketplace para toda la máquina, así que un mismo nombre no puede servir `main` en tu configuración de usuario y `develop` en un proyecto. El estable es `gitmunk` (desde `main`) y el beta es `gitmunk-beta` (desde `develop`). Consulta [Canales](#canales).

**El nombre de una skill coincide con el de una skill de otro plugin. ¿Cómo la invoco?** Añade el prefijo del plugin: `/dev-skills:dev-review-pr` en Claude Code. Codex siempre muestra las skills de los plugins con el prefijo, como `dev-skills:dev-review-pr`.

**¿Por qué Codex necesita `npm ci --prefix`?** Los scripts helper de `dev-skills` necesitan un paquete npm con versión bloqueada. Claude Code lo instala a partir del `package-lock.json` del plugin, pero Codex no instala las dependencias npm de los plugins, así que ejecuta `npm ci --prefix "<installed plugin folder>"` una vez después de instalar o actualizar.

**¿Cómo fijo una versión?** Usa un SHA de commit completo de 40 caracteres allí donde cada herramienta lo admita; [Versiones](#versiones) muestra la forma para Claude Code, Codex y el flujo Ask. Cada release también se etiqueta como `vX.Y.Z`.

**¿Los flujos Ask están activados por defecto?** No. Desde la 0.3.0, un agente solo se ejecuta cuando su variable de repositorio (`CLAUDE_ACTION_ENABLED` o `CODEX_ACTION_ENABLED`) es `true` y su secreto llega al flujo de trabajo; en caso contrario, la ejecución se detiene en el enrutamiento y deja el motivo en el log. Consulta [configurar un repositorio](../scripts/github-agent/README.md#set-up-a-repository).

## Cifras

> **Marcador de posición:** todavía no hay mediciones. Esta sección mostrará resultados de ejecuciones con y sin las skills cuando los haya.

## Antes / después

> **Marcador de posición:** todavía no hay un ejemplo completo. Esta sección mostrará una misma tarea hecha con y sin una skill.

## Hecho con gitmunk

> **Marcador de posición:** todavía no hay proyectos públicos en la lista. Aquí se añadirán los proyectos que usen gitmunk y quieran aparecer.

## Documentación

| Documento | Qué cubre |
| --- | --- |
| [Guía de instalación](../docs/install.md) | Instalar, actualizar y eliminar gitmunk en Claude Code y Codex: el instalador, los ámbitos, los canales, las plantillas y la resolución de problemas |
| [CHANGELOG.md](../CHANGELOG.md) | Los cambios de cada release, con notas de migración |
| [AGENTS.md](../AGENTS.md) | Reglas para trabajar en este repositorio |
| [`dev-skills`](../plugins/dev-skills/README.md) | Las ocho skills, su autoridad y su configuración |
| [Modelo de trabajo](../plugins/dev-skills/references/work-model.md) | El modelo `ft-sty` de feats e historias que siguen `dev-analyse-rp` y `dev-refine-story` |
| [`dev-hooks`](../plugins/dev-hooks/README.md) | Cada hook, qué deniega o sobre qué pide confirmación, y su política ante fallos |
| [Ask agent](../scripts/github-agent/README.md) | Cómo configurar el flujo Ask en un repositorio |
| [`templates/claude/`](../templates/claude) | Plantillas de configuración para los canales estable y beta |
| [`templates/github/`](../templates/github) | Los flujos de trabajo llamadores de Ask |

## Desarrollo

```bash
node scripts/sync-shared.mjs            # copy shared/ helpers into each plugin
node scripts/sync-shared.mjs --check    # CI: fail on drift
(cd plugins/dev-skills && npm ci && npm test)
python3 -m unittest discover -s plugins/dev-hooks/tests
python3 -m unittest discover -s scripts/github-agent/tests
python3 -m unittest discover -s scripts/release/tests
```

Edita los helpers compartidos solo en `shared/`; los plugins llevan copias sincronizadas porque cada plugin se instala como su propia caché.

## Contribuir

Los cambios llegan a `develop`, el canal beta; `main` solo recibe releases procedentes de `develop`. Trabaja en una rama de tarea y abre un PR acotado hacia `develop`. Sigue las reglas de [AGENTS.md](../AGENTS.md): solo contenido público, los helpers compartidos se editan solo en `shared/`, y un cambio de plugin que deban recibir los consumidores sube la versión de ese plugin como `X.Y.Z-beta.N` con una entrada en `CHANGELOG.md`. Ejecuta las comprobaciones de [Desarrollo](#desarrollo) antes de hacer push.

## Patrocinadores

El patrocinio se gestiona a través de GitHub Sponsors para la organización `amyteq`, que figura en [`.github/FUNDING.yml`](../.github/FUNDING.yml). El botón Sponsor del repositorio funcionará cuando se apruebe el perfil de Sponsors de la organización; hasta entonces no lleva a ninguna parte.

## Historial de estrellas

<a href="https://www.star-history.com/?repos=amyteq%2Fgitmunk&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date&amp;theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date" />
    <img alt="Historial de estrellas de gitmunk" src="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date" />
  </picture>
</a>

## Licencia

[MIT](../LICENSE)
