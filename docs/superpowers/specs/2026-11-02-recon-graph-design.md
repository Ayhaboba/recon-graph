# Recon Graph — дизайн, спека 1 (ядро + живой краулер)

Дата: 2026-11-02. Статус: на ревью. Область: спека 1 из трёх.

## 1. Цель

Инструмент активной разведки, в котором карта цели — не отчёт, а живой граф. Узлы появляются по мере обхода, клик даёт полные данные точки, поиск по контенту подсвечивает совпадения прямо на карте.

Граф строится на движке Obsidian graph view, извлечённом из бандла 1.14.5 (`~/.config/obsidian/obsidian-1.14.5.asar`). Движок берётся **verbatim**: `graph-view.js`, `shims.js`, `sim.js`, `pixi.min.js` — байт-в-байт, как в `/home/erema/obsidian-graph/index.html`. Наши clean-room модули (`sim-core.js`, `render.js`, `data.js`, `settings.js`) в этот проект **не вендорятся**.

Форкается только то, что без Obsidian-рантайма не работает: панель настроек и сборщик данных. Форк — тонкий адаптер, оригинал остаётся рядом; каждое отклонение фиксируется в `VENDOR.md`.

## 2. Декомпозиция

| спека | содержание | статус |
|---|---|---|
| 1 | ядро: БД, сканер URL, словарный фаззер, live-стрим, клиент-граф, инспектор, поиск | эта спека |
| 2 | импортёры: директория, HAR, JS-бандлы | позже |
| 3 | второй этаж: дифф сканов, фаззинг параметров, экспорт, метки | позже |

Порядок 1→2→3 обязателен: импортёры бесполезны без БД и графа, дифф бесполезен без обоих.

## 3. Архитектура

Два процесса, одна БД на скан, SQLite в режиме WAL.

```
bin/scanner.js  -- единственный писатель -->  data/scans/<id>.sqlite
                                              data/bodies/<xx>/<sha256>
bin/server.js   -- только читатель -------->  HTTP статика + WS
                                                 |
                                            браузер: граф (verbatim движок)
```

Почему два процесса: скан идёт минутами, окно можно закрыть и перезагрузить, скан продолжается. WAL даёт чтение во время записи без блокировок — писатель один, читателей много. Падение рендера не убивает сбор.

## 4. Доменная модель

### 4.1 Узлы

| тип | что это | key |
|---|---|---|
| `page` | HTML-документ или SPA-роут | `GET https://host/path` |
| `endpoint` | не-HTML ответ: XHR, API, JSON, редирект | `GET https://host/api/x?norm=1` |
| `asset` | js/css/img/font/pdf | `GET https://host/app.js` |
| `artifact` | находка: флаг, секрет, ключ, ошибка, коммент | `artifact:<rule>:<sha1(snippet)>` |
| `param` | параметр запроса, замеченный у endpoint | `param:https://host/a?id` |
| `unresolved` | ссылка есть, ответа нет | как у цели |

Нормализация `key`: схема и host в нижний регистр, трейлинг слеш убран, query-параметры отсортированы, дефолтные порты убраны, `index.html` схлопнут в `/`. Для `param` значение в ключ не входит — иначе `?id=1..1000` взрывает граф.

### 4.2 Рёбра

| kind | откуда → куда | смысл |
|---|---|---|
| `link` | page → page/asset/unresolved | `<a href>`, `src`, `script`, `form action` |
| `request` | page/asset → endpoint | страница или JS вызвали запрос |
| `contains` | page → artifact, asset → endpoint | находка в теле; эндпоинт из JS-бандла |
| `fuzzed` | page → endpoint/artifact | найдено перебором |
| `imported` | любой → любой | импорт директории/HAR (спека 2) |

### 4.3 Маппинг в движок

Рендерер Obsidian знает ровно пять окрасок. Маппинг:

| тип узла | тип движка |
|---|---|
| `page` | `""` |
| `endpoint` | `attachment` (жёлтый) |
| `artifact` | `tag` (зелёный) |
| `unresolved` | `unresolved` (серый, alpha 0.5) |
| `asset` | `""` + colour group `path:/\.(js|css|png|woff2|svg)$/` |
| `param` | `attachment` + colour group |
| фокус (клик) | `focused` |

Вес узла = степень (входящие + исходящие); размер движок считает сам: `clamp(3*sqrt(w+1), 8, 30)`. Важность (статус, размер тела) живёт в инспекторе и сортировке поиска, не в весе.

В спеке 1 `param` создаётся только как факт наблюдения. Фаззинг значений параметров — спека 3.

## 5. Схема SQLite

Один файл на скан: `data/scans/<scan_id>.sqlite`. Тела: `data/bodies/<sha256[0:2]>/<sha256>`.

`PRAGMA journal_mode=WAL; synchronous=NORMAL; busy_timeout=5000; foreign_keys=ON;`

Версия схемы — `PRAGMA user_version`, шаги миграции — массив в `lib/migrate.js`.

```sql
CREATE TABLE scans (
  id           INTEGER PRIMARY KEY,
  target       TEXT NOT NULL,
  mode         TEXT NOT NULL,
  root_key     TEXT,
  status       TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  stats_json   TEXT NOT NULL DEFAULT '{}',
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER
);

CREATE TABLE nodes (
  id         INTEGER PRIMARY KEY,
  scan_id    INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  type       TEXT NOT NULL,
  label      TEXT,
  url        TEXT,
  method     TEXT,
  status     INTEGER,
  depth      INTEGER,
  origin     TEXT NOT NULL,
  attrs_json TEXT NOT NULL DEFAULT '{}',
  degree     INTEGER NOT NULL DEFAULT 0,
  rev        INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  UNIQUE(scan_id, key)
);
CREATE INDEX nodes_scan_type   ON nodes(scan_id, type);
CREATE INDEX nodes_scan_status ON nodes(scan_id, status);
CREATE INDEX nodes_scan_rev    ON nodes(scan_id, rev);

CREATE TABLE edges (
  id         INTEGER PRIMARY KEY,
  scan_id    INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  src        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  dst        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  attrs_json TEXT NOT NULL DEFAULT '{}',
  rev        INTEGER NOT NULL DEFAULT 0,
  UNIQUE(scan_id, src, dst, kind)
);
CREATE INDEX edges_scan_src ON edges(scan_id, src);
CREATE INDEX edges_scan_dst ON edges(scan_id, dst);
CREATE INDEX edges_scan_rev ON edges(scan_id, rev);

CREATE TABLE bodies (
  node_id       INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  mime          TEXT,
  encoding      TEXT,
  size          INTEGER,
  sha256        TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  title         TEXT,
  text          TEXT,
  fts_truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX bodies_sha ON bodies(sha256);

CREATE TABLE fts_docs (
  node_id INTEGER PRIMARY KEY,
  scan_id INTEGER NOT NULL,
  url     TEXT,
  title   TEXT,
  body    TEXT
);
CREATE VIRTUAL TABLE node_fts USING fts5(
  url, title, body,
  content='fts_docs', content_rowid='node_id',
  tokenize='unicode61 remove_diacritics 2', prefix='2 3'
);

CREATE TABLE findings (
  id         INTEGER PRIMARY KEY,
  scan_id    INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  node_id    INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  rule       TEXT NOT NULL,
  severity   TEXT NOT NULL,
  snippet    TEXT NOT NULL,
  offset     INTEGER,
  attrs_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX findings_scan_rule ON findings(scan_id, rule);

CREATE TABLE queue (
  id         INTEGER PRIMARY KEY,
  scan_id    INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  kind       TEXT NOT NULL,
  depth      INTEGER NOT NULL DEFAULT 0,
  origin     TEXT NOT NULL,
  state      TEXT NOT NULL,
  priority   INTEGER NOT NULL DEFAULT 0,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  UNIQUE(scan_id, url, kind)
);
CREATE INDEX queue_state ON queue(scan_id, state, priority DESC);
```

Триггеры (обязательны, без них нет дельты):

- `nodes` AFTER INSERT / AFTER UPDATE OF type,status,degree,attrs_json → `rev = (SELECT COALESCE(MAX(rev),0)+1 FROM nodes)`
- `edges` AFTER INSERT → то же для `edges`
- `edges` AFTER INSERT / AFTER DELETE → `degree ±1` обоим концам (это само дёргает `rev` узла)
- `fts_docs` AFTER INSERT / DELETE / UPDATE → синхронизация `node_fts` (`INSERT INTO node_fts(node_fts, rowid, url, title, body) VALUES('delete', ...)` для удаления/обновления, затем `INSERT INTO node_fts(rowid, url, title, body) VALUES (new.node_id, ...)`)

Решения:

- `bodies.text` дублирует файл осознанно: FTS5 индексирует из БД, не читая диск на каждый запрос. Тела > 2 МБ в индекс не идут (`fts_truncated=1`), их поиск — отдельный файловый проход.
- `key` нормализован, `UNIQUE(scan_id, key)`: повторный URL не создаёт узел, только обновляет поля.
- `degree` держится триггером, потому что движку нужен `weight` при каждом `setData`.
- `queue` в БД, а не в памяти: скан останавливается и продолжается, сервер видит прогресс.
- `artifact`-узлы агрегируют `findings` по `(rule, sha1(snippet))`; сами вхождения остаются в `findings`.

## 6. Протокол WS

Один канал, JSON, `proto=1`. Снапшот страницами по 5000 узлов.

Клиент → сервер:

```json
{"t":"hello","proto":1}
{"t":"scans"}
{"t":"open","scanId":7,"rev":0}
{"t":"page","scanId":7,"after":12500,"limit":5000}
{"t":"search","q":"Delta","mode":"fts"}
{"t":"node","id":4412}
{"t":"action","id":4412,"cmd":"refetch"}
{"t":"action","scanId":7,"cmd":"stop"}
{"t":"close","scanId":7}
```

Сервер → клиент:

```json
{"t":"scans","items":[{"id":7,"target":"https://host","status":"running","nodes":3201,"edges":5103}]}
{"t":"snapshot","scanId":7,"cursor":{"rev":9012},"nodes":[{"id":1,"key":"GET https://host/","type":"page","label":"/","status":200,"degree":12,"depth":0}],"edges":[[1,2,"link"]]}
{"t":"delta","scanId":7,"cursor":{"rev":9050},"nodes":[],"edges":[]}
{"t":"progress","scanId":7,"stats":{"pending":41,"inflight":6,"done":1802,"err":3,"nodes":3201,"edges":5103}}
{"t":"search","q":"Delta","tookMs":18,"hits":[{"nodeId":4412,"snippet":"...Delta{...}","rule":"flag"}]}
{"t":"node","id":4412,"node":{},"headers":{},"findings":[],"body":{"mime":"text/html","size":8123,"preview":"..."}}
```

Дельта считается по `rev`, а не по `rowid`: обновление `degree` и `status` тоже должно доезжать до клиента.

Пуш: сервер поллит `SELECT ... WHERE rev > :cursor` каждые 250 мс и рассылает подписчикам. Никаких триггеров БД → сервер, никаких брокеров.

### 6.1 Адаптер в данные движка

Формат движка: `{nodes: {id: {type, links: {target: true}}}, numLinks}`.

`reconDataset()` делает две вещи: `key` → графовый `id` (он и есть `key`), `kind` ребра → `links`.

Инкремент: на каждую дельту собирается **частичный** dataset из всех новых узлов, всех узлов с изменившимся `degree` и всех `src` новых рёбер; для каждого — полная карта `links` из БД. Дальше `R.setData(partial)`, движок мержит по id.

Только новых узлов недостаточно: ребро может связать два давно существующих узла, и без `links` у `src` движок его не увидит.

### 6.2 Расширение рендерера

Один метод, больше ничего:

```js
Renderer.prototype.setEmphasis = function (ids) // Set<string> | null
```

`null` — обычный режим. Иначе узлы вне набора получают `alpha 0.2`, из набора — полную альфу и акцентный круг. Считается в кадре, culling не ломает, физика не затрагивается.

## 7. Клиент

Отдельный проект `recon-graph/`, движок копией в `web/vendor/`.

```
recon-graph/
  bin/    scanner.js  server.js
  lib/    db.js  migrate.js  norm.js  crawl.js  fuzz.js  extract.js  rules.js  stream.js
  web/    index.html  recon.js  inspector.js
          vendor/{graph-view,shims,sim}.js  vendor/{pixi.min.js,graph.css,panel.css}
  data/   scans/*.sqlite  bodies/<xx>/<sha256>
```

Страница: граф на весь экран; сверху строка — выбор скана, поиск, статус (`nodes 3201 · edges 5103 · pending 41`); справа колонка 320 px с вкладками **Settings** и **Inspector**.

Поток:

1. `open scanId` → снапшот страницами → `reconDataset()` → `R.setData(dataset)`.
2. `delta` → частичный dataset → `R.setData(partial)`.
3. `search` → `R.setEmphasis(new Set(ids))` + виртуализованный список результатов со сниппетами.
4. `node` → инспектор.
5. клик по узлу → локальный подграф (`buildLocal` из оригинального сборщика данных), кнопка «← global».
6. фильтры → локальный пересчёт по загруженным узлам, без запросов.

Наследуется от движка без изменений: перетаскивание узлов (`dragNode`, `forceNode`, `alphaTarget 0.3` при захвате), hover-подсветка соседей, зум/пан с инерцией, клавиатурная навигация, стрелки, затухание текста, culling, локальный граф.

### 7.1 Панель настроек

Оригинальная панель (`GraphSettingsTab`) тянет `Setting`, `ToggleComponent`, `registerOptionListener` и живёт только в Obsidian. Форкается адаптер: секции Display, Forces, Groups наследуются 1:1, секция Filters переписывается под рекон-семантику.

Фильтры рекон: `pages · endpoints · assets · artifacts · params`, `status: 2xx/3xx/4xx/5xx/—`, `origin: crawl / fuzz / import`. Слайдерная математика `F2`/`R2`, дефолты и диапазоны — как в оригинале.

### 7.2 Инспектор

- шапка: тип, метод, URL, статус, размер, время, depth, origin
- кнопки: `curl`, `open`, `refetch`, `subgraph`, `copy URL`
- headers — таблица
- findings — список с rule и severity, клик → прыжок к сниппету
- body preview — `<pre>` с подсветкой, обрезка 200 КБ, полный текст по кнопке «load full»

### 7.3 Поиск

FTS5-запрос **без `LIMIT`**, regex-режим — по всем телам без лимита. Список результатов виртуализован и подгружается по скроллу. `setEmphasis` получает весь набор id. В статусе честно: `найдено N · 1.8 с`.

## 8. Сервер и сканер

Зависимости: `ws` и SQLite (`node:sqlite`, при недоступности — `better-sqlite3`). HTTP-статика на `node:http`. HTML разбирается регулярками: нужны ссылки и `<title>`, полноценный DOM не нужен.

`bin/server.js`: статика `web/`, WS, поллинг `rev` каждые 250 мс, рассылка дельт, список сканов по файлам `data/scans/*.sqlite`. В БД скана не пишет никогда.

`bin/scanner.js` — единственный писатель:

```
node bin/scanner.js https://host --wordlist lists/common.txt \
     --concurrency 8 --per-host 4 --delay 100 --max-depth 6 \
     --scope same-origin --ignore-robots --header "Cookie: ..."
```

- очередь в БД: `pending → inflight → done|skip|err`
- дедуп по `key` до запроса
- `robots.txt` уважается по умолчанию, `--ignore-robots` для лабораторий
- скоуп `same-origin` по умолчанию, `--scope host|any` расширяет
- редиректы до 10, каждый хоп — отдельный узел `endpoint` с `origin=crawl`
- тело > 10 МБ не качаем (`attrs.truncated`), в FTS до 2 МБ
- `SIGINT` → `inflight → pending`, `status=stopped`; `--resume <scan_id>` продолжает

Извлечение (`lib/extract.js`): `a[href]`, `area`, `link`, `script[src]`, `img[src|srcset]`, `iframe`, `form[action]`, `meta refresh`, `url()` в CSS; из JS — строковые литералы с путями и шаблонами; `sitemap.xml` и `robots.txt` как источники. Найденный JS не исполняется.

Фаззинг (`lib/fuzz.js`): wordlist × каждый каталог из очереди; попадание — 200/204/301/302/307/401/403; промах — 404/410; soft-404 детектится по совпадению размера и хэша тела с эталонной страницей. `origin=fuzz`, ребро `fuzzed`.

Правила находок (`lib/rules.js`), таблица расширяемая: `flag{...}`, `CTF{...}`, секреты рядом с `secret|token|key`, `AKIA[0-9A-Z]{16}`, `BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY`, `password\s*[=:]`, стектрейсы, `TODO|FIXME|HACK`. Совпадение → `findings` + агрегированный `artifact`-узел.

Вежливость по умолчанию: concurrency 8, per-host 4, задержка 100 мс, таймаут 15 с, `User-Agent: recon-graph/1.0`.

Сервер не исполняет найденное, не рендерит тела (в инспекторе только `<pre>`), не делает внешних запросов кроме `refetch` по уже известному ключу.

## 9. Порядок сборки

| # | что | критерий «готово» |
|---|---|---|
| 0 | каркас, вендоринг verbatim + `VENDOR.md` с sha256 | `web/index.html` открывается, демо-граф рисуется, drag узлов работает |
| 1 | `lib/db.js` + миграции: схема, `rev`-триггеры, FTS5, degree | `--self-test`: скан, 3 узла, 2 ребра, FTS находит слово, degree = 2 |
| 2 | `norm.js`, `extract.js`, `rules.js` | `node --test`: 5 HTML + 3 JS фикстуры; `key` у `//host/a?b=2&a=1` и `https://host/a?a=1&b=2` совпадает |
| 3 | `crawl.js` + `scanner.js`: очередь, robots, лимиты, SIGINT/resume | скан локального сайта до глубины 3; повтор не плодит дубли; Ctrl-C → `stopped`; `--resume` продолжает |
| 4 | `fuzz.js` | `/admin`, `/backup.zip`, `/api/v1/` находятся; `/nonexistent` нет; soft-404 не находка |
| 5 | `server.js` + `stream.js` | параллельно сканер и клиент: узлы появляются без F5, два окна видят одно |
| 6 | `web/recon.js` | переключение между сканами без перезагрузки страницы |
| 7 | `inspector.js` + `refetch/curl/open/subgraph` | клик даёт детали; `refetch` прилетает дельтой; `subgraph` строит локальный граф |
| 8 | поиск без лимитов + `setEmphasis` + виртуализация | `flag` подсвечивает все совпадения, счётчик честный, список скроллится гладко |
| 9 | форк панели под рекон-фильтры | выключение `assets` убирает их; `status 4xx` оставляет ошибки; силы работают |
| 10 | полировка: тосты, `--resume`, README | три команды из README → работающий скан и граф |

Спека 1 готова, когда: скан живого сайта (глубина 3 + wordlist) растит граф в реальном времени в двух окнах; клик даёт инспектор с заголовками и находками; поиск подсвечивает все совпадения; фильтры по типу/статусу/источнику работают; скан останавливается и продолжается; drag узлов и локальный граф ведут себя как в Obsidian.

Этапы 1–4 не трогают браузер, этапы 5–9 не трогают сканер. Сломанный клиент не мешает собирать данные, и наоборот.

## 10. Верификация

- `node --test` — юнит-тесты `norm`, `extract`, `rules`, `db`, `fuzz`.
- эталонная локальная фикстура `tests/site/` (5 страниц, `/admin`, `/backup.zip`, ссылки, JS с эндпоинтами, страница с `flag{demo}`) — на ней проверяются этапы 3, 4, 8.
- «два окна» — ручная проверка живого стрима.
- сверка с Obsidian: `web/index.html` на демо-датасете визуально совпадает с `/home/erema/obsidian-graph/index.html` (тот же движок, тот же вендоринг).

## 11. Задача: скилл для агента (пентест через этот проект)

После реализации спеки 1 создаётся скилл, который позволяет другому агенту использовать проект для поиска уязвимостей. Скилл — не часть кода, а инструкция поверх него. Дизайн скилла:

### 11.1 Идентификация

- имя: `pentest-recon-graph`
- расположение: `~/.config/opencode/skills/pentest-recon-graph/SKILL.md`
- триггеры в описании: «проведи рекон», «просканируй сайт», «пентест», «найди уязвимости», «разведка по цели», «recon this», «scan target»
- в скилле обязательно: сначала прочитать `README.md` и `VENDOR.md` проекта, чтобы знать команды и границы

### 11.2 Рабочий процесс агента

1. **Scope.** Агент фиксирует цель, скоуп (домен/пути), глубину, режим (`--ignore-robots` только для явно лабораторных целей), и записывает это в `data/scans/<id>.scope.md`. Без зафиксированного скоупа скан не запускается.
2. **Сбор.** `node bin/scanner.js <target> --wordlist ... --max-depth ... --scope ...`; параллельно `node bin/server.js`; граф доступен локально для человека.
3. **Триаж находок.** Агент читает `findings` через `node lib/db.js --scan <id> --findings --json` (или FTS-запросы), группирует по `rule`/`severity`, отбрасывает шум.
4. **Проверка гипотез.** Для каждой группы — точечные запросы через `refetch`/`curl`-вывод, минимум подтверждений: статус, тело, заголовки. Один находка — один вердикт: `confirmed | likely | false-positive`.
5. **Связи.** Агент использует граф как аргумент: узел-хаб с 40 потомками и 5xx на детях — приоритет; `artifact`-узел, связанный с публичной `page` — выше, чем висящий отдельно.
6. **Отчёт.** Markdown: цель и скоуп, карта (список топ-узлов по степени + типы), находки с severity/URL/доказательством, рекомендации, что не проверено. Скриншот графа прикладывается, если человек его сделал.

### 11.3 Жёсткие правила скилла

- скилл не расширяет скоуп молча: новые домены — только с подтверждения человека;
- никаких деструктивных запросов (POST/DELETE на реальные цели) без явного разрешения; скилл по умолчанию работает в read-only (`GET`/`HEAD`);
- каждый вывод помечается источником: `confirmed` подкреплён телом/заголовком, а не «похоже»;
- секреты из `findings` в отчёт попадают маскированными (`AKIA…XXXX`), полное значение — только по запросу человека.

### 11.4 Критерий готовности скилла

Скилл готов, когда свежий агент, прочитав только `SKILL.md`, проходит путь «цель → скан → триаж → отчёт» на эталонной фикстуре `tests/site/` без подсказок, и отчёт содержит хотя бы одну подтверждённую находку (`flag{demo}`) с доказательством.

## 12. Отклонения и риски

| риск | реакция |
|---|---|
| оригинальная панель настроек не поднимается без Obsidian-реактивности | форк-адаптер; фильтры рекон пишутся руками, Display/Forces/Groups копируются |
| FTS5 без `LIMIT` на 100k+ телах медленный | честный счётчик и время в статусе; индексы `prefix='2 3'`; при необходимости — отдельный «поиск по всем» с прогрессом |
| soft-404 даёт ложные находки фаззера | эталонная 404-страница по хэшу тела и размеру в пределах 5% |
| `rev`-триггеры дороги на больших вставках | вставка батчами по 200 узлов в одной транзакции |
| движок не тянет 50k+ узлов при живом росте | culling и lazy Graphics уже в движке; при тормозах — детект «большой скан» и подсказка включить локальный граф |

Открытых вопросов нет.

---

## Приложение A. Форматы

`dataset` для движка:

```json
{
  "nodes": {
    "GET https://host/": { "type": "", "links": { "GET https://host/a": true } },
    "GET https://host/a": { "type": "attachment", "links": {} }
  },
  "numLinks": 1
}
```

`weights` (опционально, из степени):

```json
{ "GET https://host/": 12 }
```

## Приложение B. Что вендорится и откуда

| файл | источник | режим |
|---|---|---|
| `vendor/graph-view.js` | `app.pretty.js` 95271–96084 | verbatim + `setEmphasis` |
| `vendor/shims.js` | `app.pretty.js` хелперы | verbatim |
| `vendor/sim.js` | `app/sim.js` | verbatim, байт-в-байт |
| `vendor/pixi.min.js` | бандл Obsidian 7.2.4 | verbatim, sha256 сверен |
| `vendor/graph.css` | `app.css` 16750–16802 + палитра | verbatim |
| `vendor/panel.css` | форк `obsidian-graph/src/clean/panel.css` | адаптация |
| панель настроек | `raw-settings.js` | форк-адаптер под рекон-фильтры |
| сборщик данных | `raw-data.js` | форк: источник SQLite вместо кэша |
