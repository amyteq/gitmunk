<div dir="rtl">

# 🐿️ gitmunk

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · **[العربية](README.ar.md)** · [Русский](README.ru.md)

تُرجمت هذه الصفحة من ملف README الإنجليزي عند الإيداع [5ed4276](https://github.com/amyteq/gitmunk/blob/5ed427694c220c82f7394498f1d8067f0d31f5d5/README.md)، وقد تتأخر عن النسخة الإنجليزية.

[![CI](https://github.com/amyteq/gitmunk/actions/workflows/ci.yml/badge.svg)](https://github.com/amyteq/gitmunk/actions/workflows/ci.yml)
[![أحدث إصدار](https://img.shields.io/github/v/release/amyteq/gitmunk?style=flat-square&label=release)](https://github.com/amyteq/gitmunk/releases)
[![ترخيص MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](../LICENSE)

مجموعة أدوات بحجم الجيب من مهارات الوكلاء وخطافات الحماية ومسارات عمل GitHub، للفرق الصغيرة التي تعمل مع Claude Code وCodex. سوق واحد وإضافتان؛ ثبّت فقط ما يحتاجه مشروعك.

<div dir="ltr">

| الإضافة | ما تضيفه |
| --- | --- |
| [`dev-skills`](../plugins/dev-skills) | ثماني مهارات للوكلاء للعمل على GitHub: تنقيح المشكلات وتحويلها إلى أوامر عمل، ومراجعة طلبات السحب ودمجها، وشرح القرارات المعلّقة، وضغط السلاسل الطويلة، وتتبّع سلاسل النقاشات، وتخطيط الميزات والقصص. انظر [المهارات](#المهارات). |
| [`dev-hooks`](../plugins/dev-hooks) | خطافات حماية وتدقيق لـ Claude Code |

</div>

ضمن GitHub Actions: سير عمل «Ask agent» قابل لإعادة الاستخدام ([`.github/workflows/ask-agent.yml`](../.github/workflows/ask-agent.yml)) يتيح لـ Claude Code أو Codex الرد على الإشارات في المشكلات وطلبات السحب والنقاشات. انسخ ملفات الاستدعاء الخفيفة من [`templates/github/`](../templates/github).

## البدء السريع

1. ثبّت الإضافات كما هو موضّح في [التثبيت](#التثبيت).
2. داخل نسخة محلية من مستودع على GitHub، ومع تسجيل الدخول في GitHub CLI (`gh`)، حوّل مشكلة إلى أمر عمل:

   <div dir="ltr">

   ```text
   /dev-refine-issue 42
   ```

   </div>

   في Codex، استدعِها بالشكل `$dev-refine-issue 42`. تقرأ المهارة المشكلة وملف `AGENTS.md` في المستودع، ثم تنشر تعليق مهمة يتضمن معايير القبول وموجّهات تشغيل قابلة للنسخ. ولا تنفّذ العمل المطلوب في المشكلة.

## آلية العمل

- **سوق واحد وإضافتان.** هذا المستودع سوق إضافات ([`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)) يدرج `dev-skills` و`dev-hooks`. يثبّت كل من Claude Code وCodex كل إضافة في ذاكرة التخزين المؤقت للإضافات الخاصة به، فلا يُنسخ شيء إلى مستودعك.
- **المهارات** تعليمات مصحوبة بأدوات مساعدة صغيرة مكتوبة بـ Node.js. يحمّل الوكيل المهارة عندما تستدعيها باسمها، ويقرأ ملفي `AGENTS.md` و`CLAUDE.md` في مستودعك لمعرفة قواعد المشروع، ولا يُجري من عمليات الكتابة إلا ما تصفه المهارة.
- **الخطافات** (`dev-hooks`، في Claude Code فقط) سكربتات Python تعمل حول استدعاءات الأدوات. فهي ترفض الاستدعاءات المدمّرة والاستدعاءات التي تقرأ الأسرار، أو تطلب التأكيد قبل تنفيذها، وتمنع دمج طلب سحب يخص شخصًا آخر، وتسجّل الأحداث بعد حجب البيانات الحساسة منها.
- **سير عمل Ask** سير عمل قابل لإعادة الاستخدام في GitHub Actions يتيح لـ Claude Code أو Codex الرد على الإشارات `@claude` و`@codex` في المشكلات وطلبات السحب والنقاشات. ينسخ المستودع ملف استدعاء خفيفًا من [`templates/github/`](../templates/github)، ولا يعمل كل وكيل إلا عندما تكون قيمة متغير المستودع الخاص به `true` ويكون السر الخاص به مضبوطًا.
- **القنوات** فروع: القناة المستقرة تأتي من `main` والتجريبية من `develop`، تحت اسمين مختلفين للسوق. انظر [الإصدارات](#الإصدارات).

## المهارات

<div dir="ltr">

| المهارة | ما تفعله |
| --- | --- |
| [`dev-refine-issue`](../plugins/dev-skills/skills/dev-refine-issue/SKILL.md) | تنقّح مشكلة قائمة وتحوّلها إلى أمر عمل محدود النطاق، مع معايير قبول قابلة للملاحظة وتعليق مهمة مستقل وموجّهات تشغيل قابلة للنسخ. ولا تنفّذ العمل المطلوب في المشكلة أبدًا. |
| [`dev-review-pr`](../plugins/dev-skills/skills/dev-review-pr/SKILL.md) | تُجري جولات محدودة من مراجعة طلب السحب وإصلاحه عبر جلسات مستقلة من Codex أو Claude Code، مع قرارات معالجة مرتبطة بالأدلة ومراجعة كاملة نهائية قبل الموافقة. |
| [`dev-merge`](../plugins/dev-skills/skills/dev-merge/SKILL.md) | تدمج طلب سحب واحدًا تمت مراجعته دمجًا مضغوطًا (squash) عندما يطلب المالك ذلك صراحةً، وتتحقق من الشجرة المدموجة، وتنظّف، وتنشر تعليق إغلاق، وتحدّث المشكلات والمتتبّعات المرتبطة. ولا تدمج أبدًا بمبادرة منها. |
| [`dev-explain`](../plugins/dev-skills/skills/dev-explain/SKILL.md) | تشرح القرارات البشرية المعلّقة في مشكلة أو طلب سحب أو نقاش واحد، مع الخلفية والأمثلة وتوصية ومقارنة بين الخيارات، ثم تضيف تعليق نتيجة واحدًا. ولا تقرّر شيئًا. |
| [`dev-compact`](../plugins/dev-skills/skills/dev-compact/SKILL.md) | تضغط مشكلة أو طلب سحب أو نقاشًا واحدًا بحسب المستوى: تُبقي النقاط الرئيسية في المتن، وتنقل التفاصيل حرفيًا إلى تعليقات جديدة، وتضيف تعليق نتيجة واحدًا. وتبقى مناطق AUTO ومعايير القبول مطابقة بايتًا ببايت. |
| [`dev-track`](../plugins/dev-skills/skills/dev-track/SKILL.md) | تجمع كل النقاشات غير المعالَجة من فئة واحدة، مثل محاضر الاجتماعات، في نقاش المتتبّع الخاص بتلك الفئة، وتدمج مهام TODO الواردة فيها، وتعلّم كلًا منها بأنه منجز ثم تغلقه. تكتفي افتراضيًا بإعداد مسودة، ولا تكتب إلا مع `--apply`. |
| [`dev-analyse-rp`](../plugins/dev-skills/skills/dev-analyse-rp/SKILL.md) | تحلّل حزمة طلب واحدة (مسار محلي أو مشكلة أو نقاش) إلى مقترح للتخطيط فقط يتضمن خريطة قصص وشرائح تسليم ووحدات مرشحة ومخطط تبعيات ومراجعة مستقلة. ولا تفتح طلب سحب واحدًا يضم مستندات الميزات والقصص، مع التسميات ومشكلات التتبّع، إلا بتفويض صريح. |
| [`dev-refine-story`](../plugins/dev-skills/skills/dev-refine-story/SKILL.md) | تربط قصة `STY_<n>` بمشكلة واحدة بالضبط على GitHub، ثم تسلّم العمل إلى `dev-refine-issue`. ولا تنفّذ القصة أبدًا. |

</div>

## التثبيت

شغّل المثبّت (Node.js 20 أو أحدث). يسألك عن القناة والنطاق والوكلاء، ويطبع كل خطوة، ولا يغيّر شيئًا حتى تؤكد:

<div dir="ltr">

```bash
npx --allow-git=root github:amyteq/gitmunk
```

</div>

لا يشغّل npm 12 حزمة مباشرةً من مستودع git إلا مع `--allow-git=root`. يغطي [دليل التثبيت](../docs/install.md) أسئلة المثبّت وخياراته، والنطاقات، والقناة التجريبية، وقوالب الإعدادات، والتحديث، وإلغاء التثبيت، واستكشاف الأخطاء وإصلاحها.

للتثبيت يدويًا بدلًا من ذلك:

### Claude Code

<div dir="ltr">

```bash
claude plugin marketplace add amyteq/gitmunk#main
claude plugin install dev-skills@gitmunk
claude plugin install dev-hooks@gitmunk      # optional: the guardrail hooks
```

</div>

لمشاركة الإضافات مع فريق، ادمج [`templates/claude/settings.json`](https://github.com/amyteq/gitmunk/blob/5ed427694c220c82f7394498f1d8067f0d31f5d5/templates/claude/settings.json) في ملف `.claude/settings.json` الخاص بالمشروع بدلًا من ذلك.

### Codex

<div dir="ltr">

```bash
codex plugin marketplace add amyteq/gitmunk --ref main
codex plugin add dev-skills@gitmunk
npm ci --prefix "${CODEX_HOME:-$HOME/.codex}/plugins/cache/gitmunk/dev-skills/<version>"
```

</div>

لا يثبّت Codex تبعيات npm للإضافات، لذا يثبّت الأمر الأخير حزمة الأدوات المساعدة؛ وقيمة `<version>` هي الإصدار الذي يعرضه `codex plugin list`.

## الإصدارات

القنوات فروع: `main` هو المستقر و`develop` هو التجريبي. يجب أن تتغيّر قيمة `version` لكل إضافة في `.claude-plugin/plugin.json` حتى تتحدّث النسخ المثبّتة. انظر [CHANGELOG.md](../CHANGELOG.md).

### القنوات

<div dir="ltr">

| القناة | السوق | المرجع | معرّفات الإضافات | القالب |
| --- | --- | --- | --- | --- |
| المستقرة (الافتراضية) | `gitmunk` | آخر إيداع في `main` | `dev-skills@gitmunk`، `dev-hooks@gitmunk` | [`templates/claude/settings.json`](https://github.com/amyteq/gitmunk/blob/5ed427694c220c82f7394498f1d8067f0d31f5d5/templates/claude/settings.json) |
| التجريبية | `gitmunk-beta` ([الفهرس](../channels/beta/.claude-plugin/marketplace.json)) | آخر إيداع في `develop`، بإصدارات مثل `0.3.0-beta.1` | `dev-skills@gitmunk-beta`، `dev-hooks@gitmunk-beta` | [`templates/claude/settings.beta.json`](https://github.com/amyteq/gitmunk/blob/5ed427694c220c82f7394498f1d8067f0d31f5d5/templates/claude/settings.beta.json) |

</div>

ينضم المشروع إلى القناة التجريبية بدمج القالب التجريبي في ملف `.claude/settings.local.json` الخاص به (لك وحدك) أو في `.claude/settings.json` (للفريق كله). يحمل السوقان اسمين مختلفين لأن Claude Code يسجّل مصدرًا واحدًا لكل اسم سوق على مستوى الجهاز كله؛ كما يضبط القالب التجريبي الإضافات المستقرة على `false`، حتى لا يحمّل تثبيتٌ مستقر على مستوى المستخدم المهاراتِ نفسها مرتين في ذلك المشروع. ليس لـ Codex قناة ثانية: وجّه قيمة `ref` في القسم `[marketplaces.gitmunk]` من ملف `.codex/config.toml` في المشروع إلى `develop` بدلًا من `main`. عندما يصبح الإصدار التجريبي إصدارًا نهائيًا، تُحذف اللاحقة `-beta.N` من إصدارات إضافاته، ويُدمج `develop` في `main`، ويمكن للمشاريع التجريبية الاستغناء عن القالب التجريبي. يُفشل [سير عمل الإصدار](../.github/workflows/release.yml) أي طلب سحب إلى `main` إلا إذا كان القسم العلوي في `CHANGELOG.md` عنوانًا بسيطًا بالشكل `## X.Y.Z`، وخلت الإصدارات كلها من لاحقة الإصدار التمهيدي، ولم يُنشأ الوسم `vX.Y.Z` بعد؛ ثم يُنشئ الدمج الوسم `vX.Y.Z` وينشر إصدارًا على GitHub تكون ملاحظاته ذلك القسم.

لربط التثبيت بإيداع محدد، استخدم قيمة SHA الكاملة المكوّنة من 40 حرفًا حيثما تقبلها كل أداة:

- في **Claude Code** قبل الإصدار v2.1.324، تُقرأ اللاحقة `#…` في عنوان URL للسوق، وكذلك قيمة `ref` للسوق، على أنها فرع أو وسم فقط؛ فتفشل قيمة SHA هناك بخطأ فرع غير موجود (يقبل الإصدار v2.1.324 وما بعده أيضًا SHA كاملًا قيمةً لـ `ref` السوق). لدعم الإصدارات الأقدم، اربط كل إضافة بإيداعها بدلًا من ذلك، في سوق خاص بك (مثل ملف `.claude-plugin/marketplace.json` في المشروع)، باستخدام مصدر من نوع `git-subdir` مع قيمة `sha` الخاصة به:

  <div dir="ltr">

  ```json
  { "name": "dev-skills", "source": { "source": "git-subdir", "url": "https://github.com/amyteq/gitmunk.git", "path": "plugins/dev-skills", "sha": "<full commit SHA>" } }
  ```

  </div>

- في **Codex**، تُقبل قيمة SHA مرجعًا للسوق: `codex plugin marketplace add amyteq/gitmunk --ref <full commit SHA>`.
- في **سير عمل Ask**، تُقبل قيمة SHA بعد `@` في حقل `uses:` من ملف الاستدعاء.

## الأسئلة الشائعة

**لماذا يوجد اسمان للسوق؟** يسجّل Claude Code مصدرًا واحدًا لكل اسم سوق على مستوى الجهاز كله، لذا لا يمكن لاسم واحد أن يخدم `main` في إعدادات المستخدم و`develop` في مشروع ما. القناة المستقرة هي `gitmunk` (من `main`) والتجريبية هي `gitmunk-beta` (من `develop`). انظر [القنوات](#القنوات).

**يتعارض اسم مهارة مع مهارة في إضافة أخرى. كيف أستدعيها؟** أضف بادئة الإضافة: `/dev-skills:dev-review-pr` في Claude Code. أما Codex فيعرض مهارات الإضافات دائمًا مع البادئة، بالشكل `dev-skills:dev-review-pr`.

**لماذا يحتاج Codex إلى `npm ci --prefix`؟** تحتاج السكربتات المساعدة في `dev-skills` إلى حزمة npm واحدة مقفلة الإصدار. يثبّتها Claude Code من ملف `package-lock.json` الخاص بالإضافة، لكن Codex لا يثبّت تبعيات npm للإضافات، لذا شغّل `npm ci --prefix "<installed plugin folder>"` مرة واحدة بعد التثبيت أو التحديث.

**كيف أربط التثبيت بإصدار محدد؟** استخدم قيمة SHA كاملة للإيداع من 40 حرفًا حيثما تقبلها كل أداة؛ يعرض قسم [الإصدارات](#الإصدارات) الصيغة لكل من Claude Code وCodex وسير عمل Ask. كما يحمل كل إصدار الوسم `vX.Y.Z`.

**هل سير عمل Ask مفعّل افتراضيًا؟** لا. منذ الإصدار 0.3.0 لا يعمل الوكيل إلا عندما تكون قيمة متغير المستودع الخاص به (`CLAUDE_ACTION_ENABLED` أو `CODEX_ACTION_ENABLED`) هي `true` ويصل السر الخاص به إلى سير العمل؛ وإلا يتوقف التشغيل عند مرحلة التوجيه مع ذكر السبب في السجل. انظر [إعداد مستودع](../scripts/github-agent/README.md#set-up-a-repository).

## الأرقام

> **محتوى مؤقت:** لا توجد قياسات بعد. سيعرض هذا القسم نتائج عمليات تشغيل مع المهارات ومن دونها عند توفرها.

## قبل / بعد

> **محتوى مؤقت:** لا يوجد مثال تطبيقي بعد. سيعرض هذا القسم مهمة واحدة منجزة مع مهارة ومن دونها.

## مشاريع مبنية باستخدام gitmunk

> **محتوى مؤقت:** لا توجد مشاريع عامة مدرجة بعد. ستُضاف هنا المشاريع التي تستخدم gitmunk وترغب في ذكر اسمها.

## التوثيق

<div dir="ltr">

| المستند | ما يغطيه |
| --- | --- |
| [دليل التثبيت](../docs/install.md) | تثبيت gitmunk وتحديثه وإزالته في Claude Code وCodex: المثبّت، والنطاقات، والقنوات، والقوالب، واستكشاف الأخطاء وإصلاحها |
| [CHANGELOG.md](../CHANGELOG.md) | التغييرات في كل إصدار، مع ملاحظات الترحيل |
| [AGENTS.md](../AGENTS.md) | قواعد العمل في هذا المستودع |
| [`dev-skills`](../plugins/dev-skills/README.md) | المهارات الثماني وصلاحياتها وطريقة إعدادها |
| [نموذج العمل](../plugins/dev-skills/references/work-model.md) | نموذج `ft-sty` للميزات والقصص الذي تتبعه `dev-analyse-rp` و`dev-refine-story` |
| [`dev-hooks`](../plugins/dev-hooks/README.md) | كل خطاف، وما يرفضه أو يطلب التأكيد بشأنه، وسياسته عند الفشل |
| [وكيل Ask](../scripts/github-agent/README.md) | إعداد سير عمل Ask في مستودع |
| [`templates/claude/`](../templates/claude) | قوالب الإعدادات للقناتين المستقرة والتجريبية |
| [`templates/github/`](../templates/github) | مسارات عمل الاستدعاء الخاصة بـ Ask |

</div>

## التطوير

<div dir="ltr">

```bash
node scripts/sync-shared.mjs            # copy shared/ helpers into each plugin
node scripts/sync-shared.mjs --check    # CI: fail on drift
(cd plugins/dev-skills && npm ci && npm test)
python3 -m unittest discover -s plugins/dev-hooks/tests
python3 -m unittest discover -s scripts/github-agent/tests
python3 -m unittest discover -s scripts/release/tests
```

</div>

عدّل الأدوات المساعدة المشتركة في `shared/` فقط؛ إذ تحمل الإضافات نسخًا متزامنة منها لأن كل إضافة تُثبَّت في ذاكرة تخزين مؤقت خاصة بها.

## المساهمة

تصل التغييرات إلى `develop`، أي القناة التجريبية؛ ولا يتلقى `main` إلا الإصدارات القادمة من `develop`. اعمل على فرع خاص بالمهمة وافتح طلب سحب مركّزًا إلى `develop`. اتبع القواعد الواردة في [AGENTS.md](../AGENTS.md): محتوى عام فقط، وتعديل الأدوات المساعدة المشتركة في `shared/` فقط، وأي تغيير في إضافة ينبغي أن يصل إلى المستخدمين يرفع إصدار تلك الإضافة بالشكل `X.Y.Z-beta.N` مع مدخل في `CHANGELOG.md`. شغّل الفحوص الواردة في [التطوير](#التطوير) قبل الدفع.

## الرعاة

تتم الرعاية عبر GitHub Sponsors لصالح المؤسسة `amyteq`، التي يذكرها الملف [`.github/FUNDING.yml`](../.github/FUNDING.yml). يعمل زر Sponsor في المستودع بعد الموافقة على ملف المؤسسة في Sponsors؛ وحتى ذلك الحين لا يقود إلى أي مكان.

## سجل النجوم

<a href="https://www.star-history.com/?repos=amyteq%2Fgitmunk&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date&amp;theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date" />
    <img alt="سجل نجوم gitmunk" src="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date" />
  </picture>
</a>

## الترخيص

[MIT](../LICENSE)

</div>
