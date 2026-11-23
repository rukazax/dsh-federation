<p align="center"><img src="assets/banner.svg" alt="dsh_hub — федерация DeepSeek Harness" width="100%"></p>

<h1 align="center">dsh_hub</h1>

<p align="center"><b>Одно окно на все твои DeepSeek Harness: хаб, узлы и телефон.</b></p>

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="status" src="https://img.shields.io/badge/status-alpha-orange.svg">
  <img alt="DSH" src="https://img.shields.io/badge/DSH-0.2.2--rc.5-7aa2ff.svg">
  <img alt="Android" src="https://img.shields.io/badge/Android-16%E2%80%9317-3ddc84.svg">
  <img alt="proto" src="https://img.shields.io/badge/proto-1-4de2c5.svg">
</p>

**RU** · [English](#english)

| Раздел | Что внутри |
| --- | --- |
| 🎯 [О проекте](#о-проекте) | Зачем нужна федерация из своих устройств |
| 🧭 [Принципы](#принципы) | Три правила, из которых выведено всё остальное |
| 🏗️ [Как устроено](#как-устроено) | Хаб, узлы, телефон, протокол |
| ✅ [Что уже работает](#что-уже-работает) | Хаб v0 и его проверки |
| 🧠 [Память и дашборд](#память-и-дашборд) | Один общий RAG и обзор базы Obsidian на панели |
| 🗺️ [План](#план) | Этапы, объём, приёмка |
| 📱 [Телефон и раскладные экраны](#телефон-и-раскладные-экраны) | Песочница, assist, полный доступ; FCP-N49 |
| ⚡ [Быстрый старт](#быстрый-старт) | Поднять хаб и прогнать тесты |
| 📚 [Документы](#документы) | План, приложение, протокол |

---

## О проекте

Один ноутбук, один настольный ПК, один телефон — и на каждом свой DeepSeek Harness со своими сессиями.
Хочется одного: видеть их из одного окна, отправлять промпты в чужую сессию, держать ключи LLM в одном
месте и не терять работу, когда устройство выключено.

`dsh_hub` — это **федерация**: один экземпляр DSH становится хабом, остальные — узлами. Узлы живут своей
жизнью (свои сессии, своя работа, свой офлайн), хаб видит всё, собирает общую память, хранит единственные
ключи моделей и даёт одно окно управления — на ПК и в Android-приложении.

Проект сознательно не трогает ядро DSH: всё живёт плагинами профиля и файлами состояния, поэтому
обновление DSH не превращается в починку федерации.

## Принципы

1. **Исполнение — только у хозяина.** Сессия живёт и исполняется на устройстве, где создана. Хаб управляет,
   но не исполняет чужие ходы: промпт из окна хаба доезжает до узла и исполняется там.
2. **Хаб — единственная точка прав и ключей.** Модели, allowlist, видимость сессий, статистика расходов —
   на хабе. Узлам не нужны свои ключи LLM, а если ключ пропал — запрос падает, а не уходит «куда-нибудь».
3. **Ядро DSH не трогаем.** Плагины профиля, файлы состояния, никаких форков ядра.
4. **Телефон — такой же узел, только с руками.** Приложение умеет управлять своим устройством в одном из
   трёх режимов: `sandbox` (по умолчанию), `assist` (служба доступности), `full` (Shizuku, права shell).
5. **Опасное — по подтверждению.** Инструменты уровня `phone_shell` по умолчанию спрашивают разрешение,
   каждое решение пишется в аудит, «стоп» гасит команды.

## Как устроено

```mermaid
flowchart LR
  subgraph HUB["Хаб — один из твоих DSH"]
    H["плагин dsh_hub<br/>role=hub · HTTP :18990 · SSE"]
    DB[("federation.sqlite<br/>nodes · sessions · usage · commands · audit")]
  end
  N1["Узел: настольный ПК<br/>role=node"] -->|исходящий HTTPS<br/>Bearer node-token| H
  N2["Узел: ноутбук<br/>role=node"] -->|исходящий HTTPS| H
  M["Телефон: приложение dsh_hub<br/>пульт + служба устройства"] -->|SSE + команды| H
  H --- DB
```

Ключевые части:

- **хаб** — HTTP + SSE на локальном порту, SQLite, снапшоты сессий, очередь команд, аудит;
- **узел** — плагин в профиле DSH: спаривание, отправка `index`, приём команд, исполнение у себя;
- **телефон** — нативное приложение (Kotlin + Compose): пульт и, при разрешении, руки;
- **протокол** — `proto: 1`, идемпотентные `commandId`, курсоры `Last-Event-ID` на обоих SSE.

Подробности: [протокол и модель данных](docs/FEDERATION.md).

## Что уже работает

**Хаб v0** — срез P0/P2: спаривание узлов по коду, `hello`, приём `index`, выдача списков узлов и сессий,
хранение в SQLite без зависимостей (`node:sqlite`, Node 24).

```text
$ npm test
✔ спаривание, hello, index и выдача списков
✔ данные узла переживают перезапуск хаба
ℹ pass 2 · fail 0
```

Проверено тестами: чужой код спаривания отбивается `401`, повторный `index` не плодит дубли, списки без
hub-токена закрыты, данные узла переживают перезапуск.

## План

| Этап | Что получаем | Время |
| --- | --- | --- |
| P0-«-1» Врата | 6 инвариантов парами «плохо/хорошо», контрактный чек, канареечный узел | 2 дня |
| P0 Память | спул + приём + бэкфилл → **один общий RAG** (LightRAG), метка `workspace`/`node` | 2 дня |
| P1 Узел | спаривание, токен, `index/snapshot/usage/memory`, SSE-клиент, адаптер моделей | 4–5 дней |
| P2 Хаб + UI | SQLite, снапшоты, приём, SSE наружу, панель | 5–6 дней |
| P2b Клиент Android | приложение: узлы, сессии, переписка, промпт, approvals | 5–6 дней |
| P2c Телефон как узел | служба устройства: sandbox / assist / full, `phone_*`, аудит | 3–4 недели |
| P3 Исполнение | prompt/cancel/rename, очередь, TTL, approvals-релей | 3–4 дня |
| P3a Права и модели | видимость, allowlist, прокси «единственные ворота», отзыв | 3–4 дня |
| P3b Статистика | `usage`, агрегаты, карточки, граф памяти | 2 дня |
| P4 Полировка | второй узел, офлайн-очередь, доки, чек-скрипт | 2–3 дня |

MVP (P0–P2) — около полутора недель, полный объём с телефоном — 7–8 недель агентской работы.
Этапы, критерии приёмки и риски — в [docs/PLAN.md](docs/PLAN.md).

## Память и дашборд

Память у федерации **одна на всех**: хаб уже держит `dsh-memory-hub` (ингест `session/event` всех чатов и
воркспейсов, гибридный поиск, дедуп по `hash`) и LightRAG на `127.0.0.1:9621`. Узел присылает чанки в
`POST /fed/v1/memory`, и они ложатся **в тот же индекс** с меткой `workspace`/`node` — вопрос задаётся один
раз, а не трижды по числу устройств.

Дашборд хаба показывает состояние базы не «на глаз», а конкретными числами и последним обзором. Панель
«Обзор базы» берёт готовую заметку `Аналитика/analysis-YYYY-MM-DD.md`, которую пишет `memory_analyze`, и
считает заметки по разделам — всё локально, без вызова модели. Новый анализ — по кнопке.

![Обзор базы Obsidian: 9 649 заметок, 10 513 чанков, 495 сессий](assets/vault-overview.svg)

```mermaid
flowchart LR
  D["Дашборд · «Обзор базы»"] -->|"GET /api/federation/memory/overview"| H["Хаб"]
  H -->|"локально, без LLM"| V[("Obsidian vault")]
  D -.->|"кнопка «Обновить обзор»"| A["memory_analyze"]
  A -->|"analysis-DATE.md"| V
```

- Ответ панели: заметки по разделам, объём последнего обзора, `updated_at`, полный текст обзора.
- Vault не смонтирован → `available:false`, `reason:"vault-missing"`; панель пишет «база недоступна», а не
  пустой экран и не `500`.
- Скрытая сессия в индекс не попадает, поэтому её нет и в обзоре — правило видимости одно на все пути.

## Телефон и раскладные экраны

Приложение рассчитано на три раскладки и не ломается при сгибе:

| Устройство | Ширина окна | Раскладка |
| --- | --- | --- |
| Телефон (сложен) | ~353 dp | одна колонка: список → сессия → чат по шагам |
| Раскладной (раскрыт) | ~718 dp | две колонки: слева узлы и сессии, справа переписка |
| Планшет / веб | ≥ 840 dp | три зоны: узлы, сессии, чат |

Сгиб определяется через `WindowInfoTracker` + `FoldingFeature`: `HALF_OPENED` с вертикальной складкой —
контент раскладывается по половинам и не заезжает на петлю; горизонтальная складка — верх/низ.
Состояние экрана и черновик промпта переживают сгиб и разгиб (`rememberSaveable`, `ViewModel`).

Проверено на живом устройстве: **HONOR FCP-N49**, Android 17 (API 37), два дисплея — внутренний
2156×2344 (480 dpi, ~718 dp) и внешний 1060×2376 (~353 dp). Как устроены режимы `sandbox` / `assist` / `full`
и как это принимается на телефоне — в [docs/APP.md](docs/APP.md).

## Быстрый старт

```bash
cd hub
npm test                                   # 2/2 pass
node src/hub.mjs --port 18990 --code ABCD --db ~/.dsh/federation.sqlite
```

```bash
# спаривание узла
curl -s localhost:18990/fed/v1/pair -H 'content-type: application/json' \
  -d '{"code":"ABCD","node":{"name":"desktop","os":"linux"}}'
# → {"ok":true,"nodeId":"node_…","token":"…"}
```

## Документы

- [docs/PLAN.md](docs/PLAN.md) — этапы, критерии приёмки, риски.
- [docs/APP.md](docs/APP.md) — приложение: экраны, режимы доступа, раскладные экраны, приёмка.
- [docs/FEDERATION.md](docs/FEDERATION.md) — протокол, модель данных, безопасность.

---

## English

<p align="center"><b>One window for all your DeepSeek Harnesses: hub, nodes and phone.</b></p>

**One machine becomes the hub, the rest become nodes.** Each node keeps its own sessions, its own work and its
own offline mode. The hub sees everything, collects shared memory, holds the only LLM keys and gives one
control window — on the desktop and in an Android app.

### Principles

1. **Execution stays with the owner.** A session lives and runs on the device where it was created; the hub
   commands, it never runs somebody else's turn.
2. **The hub is the single point of rights and keys.** Models, allowlists, visibility, spend statistics — on
   the hub. Nodes need no keys of their own; a missing key fails the request instead of routing it elsewhere.
3. **The DSH core is untouched.** Profile plugins and state files only.
4. **The phone is a node with hands.** `sandbox` (default), `assist` (accessibility service) and `full`
   (Shizuku, shell rights) — the device decides, the agent only asks.
5. **Dangerous tools ask.** `phone_shell` requires confirmation by default, every decision goes to the audit
   log, and a stop switch halts commands.

### Status

Hub v0 works and is covered by tests: pairing by code, `hello`, `index` ingestion, node/session listings in
SQLite with no dependencies (`node:sqlite`, Node 24). `npm test` → 2/2 pass. Node plugin, Android app and the
device service are on the roadmap (see [docs/PLAN.md](docs/PLAN.md)).

### Memory and dashboard

Memory is one shared RAG for the whole federation: the hub runs `dsh-memory-hub` (ingests `session/event`
from every chat and workspace, hybrid recall, hash dedupe) plus LightRAG on `127.0.0.1:9621`. A node posts
chunks to `POST /fed/v1/memory` and they land in the **same** index tagged with `workspace`/`node` — one
question, one answer, not one per device.

The dashboard shows the base as numbers, not vibes. The "Base overview" panel reads the latest
`Аналитика/analysis-*.md` written by `memory_analyze`, counts notes per section locally (no LLM call on open),
and offers an explicit refresh button. A missing vault answers `available:false` with `reason:"vault-missing"`
instead of a blank screen or a 500. Hidden sessions are never ingested, so they are absent from the overview
too — one visibility rule for every read path.

### Foldables

The Android app ships three layouts: compact single column (~353 dp folded), two-pane list/detail (~718 dp
unfolded) and three zones on tablets. Posture comes from `WindowInfoTracker` + `FoldingFeature`; state and
prompt drafts survive folding and unfolding. Verified on HONOR FCP-N49, Android 17 (API 37), dual display
2156×2344 inner / 1060×2376 outer. See [docs/APP.md](docs/APP.md).

### Quick start

```bash
cd hub && npm test
node src/hub.mjs --port 18990 --code ABCD --db ~/.dsh/federation.sqlite
```

### Docs

[docs/PLAN.md](docs/PLAN.md) · [docs/APP.md](docs/APP.md) · [docs/FEDERATION.md](docs/FEDERATION.md)

---

`#deepseek-harness` `#dsh` `#federation` `#self-hosted` `#android` `#kotlin` `#foldable` `#sse` `#sqlite`
