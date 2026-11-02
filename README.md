# Recon Graph

## Install

```bash
sh install.sh
```

Скрипт проверит Node.js (нужен **>= 22.5**), при необходимости скачает Node 22.x в `~/.local/node`, выполнит `npm install --no-audit --no-fund` и прогонит `lib/db.js --self-test` + `tests/stage0-smoke.js`. Проверки без установки: `sh install.sh --check`.

Вручную:

```bash
npm install
```

Требования: Node.js >= 22.5, Linux/macOS, браузер (Chromium или Firefox) для UI.

## 1. Что это

Активная карта разведки: живой граф цели вместо отчёта. Узлы появляются по мере обхода, клик даёт полные данные точки, поиск по контенту подсвечивает совпадения прямо на карте.

Граф строится на движке Obsidian 1.14.5 graph view. Файлы `graph-view.js`, `shims.js`, `sim.js`, `pixi.min.js`, `graph.css` вендорены байт-в-байт; единственная разрешённая правка — append-only `Renderer.prototype.setEmphasis` в `web/vendor/graph-view.js`. Хэши и обоснование — в `VENDOR.md`.

Два процесса, одна БД на скан:

```
bin/scanner.js  -- единственный писатель -->  data/scans/<id>.sqlite + data/bodies/
bin/server.js   -- только читатель ------->  HTTP + WebSocket --> браузер (граф)
```

Скан идёт минутами: окно можно закрыть и открыть заново, сбор не прерывается. SQLite в режиме WAL даёт чтение во время записи — один писатель, много читателей.

## 2. Требования

- Node.js **>= 22.5** — нужен встроенный `node:sqlite`.
- Linux или macOS.
- Chromium или Firefox для UI.
- `npm install` — единственная зависимость `ws`.

## 3. Быстрый старт

```bash
npm install
node bin/scanner.js http://127.0.0.1:8080/ --max-depth 3 --wordlist lists/common.txt
node bin/server.js            # http://127.0.0.1:8931/
```

Открыть `http://127.0.0.1:8931/` в браузере и выбрать скан в списке. Сервер можно запустить и до окончания скана — граф будет расти в реальном времени.

## 4. CLI сканера

```
node bin/scanner.js <target-url> [options]
```

| Флаг | Значение | По умолчанию |
|---|---|---|
| `--max-depth <n>` | максимальная глубина обхода | `6` |
| `--concurrency <n>` | глобальные параллельные запросы | `8` |
| `--per-host <n>` | параллельные запросы на хост | `4` |
| `--delay <ms>` | задержка между запросами | `100` |
| `--timeout <ms>` | таймаут запроса | `15000` |
| `--scope <mode>` | `same-origin` \| `host` \| `any` | `same-origin` |
| `--ignore-robots` | не соблюдать `robots.txt` | выкл. |
| `--header "Name: value"` | дополнительный заголовок (повторяемый) | — |
| `--wordlist <file>` | фаззить каталоги из очереди словарём | — |
| `--max-body-bytes <n>` | лимит тела ответа в байтах | `10485760` |
| `--max-redirects <n>` | лимит редиректов | `10` |
| `--data-dir <dir>` | каталог данных | `./data` |
| `--resume <scan-id>` | продолжить существующий скан | — |
| `-h, --help` | показать справку | — |

Примеры:

```bash
node bin/scanner.js https://example.test --max-depth 3
node bin/scanner.js --resume 4
```

Сервер:

```
node bin/server.js [--port N] [--host H] [--data-dir DIR]
```

`--port` по умолчанию `8931`, `--host` — `127.0.0.1`, `--data-dir` — `data` проекта.

## 5. Данные

```
data/scans/<id>.sqlite      # один файл на скан; WAL
data/bodies/<xx>/<sha256>   # тела ответов, <xx> = первые два символа sha256
```

- `PRAGMA journal_mode=WAL; synchronous=NORMAL; busy_timeout=5000; foreign_keys=ON;`
- Один писатель — сканер; сервер и клиенты только читают.
- Очередь обхода хранится в БД: скан останавливается (`SIGINT` → `stopped`) и продолжается через `--resume`.
- Тела больше 10 МБ не скачиваются; в FTS индекс идут тела до 2 МБ.

## 6. Клиент

- **Скан-селектор** — список сканов из `data/scans/*.sqlite`, переключение без перезагрузки.
- **Инспектор** — тип, метод, URL, статус, размер, время, depth, origin; headers, findings, body preview; кнопки `refetch`, `curl`, `open`, `subgraph`, `copy URL`.
- **Поиск** — FTS5 и regex по всем телам без лимита; виртуализованный список результатов; подсветка совпадений на графе через `setEmphasis`; честный счётчик и время.
- **Панель** — Filters (типы, статус, origin), Display, Forces, Groups; фильтры считаются локально по загруженным узлам.
- **Тосты** — статусы действий и ошибок.

## 7. Тесты

```bash
npm test                          # node --test tests/*.test.js — сейчас 121 тест
node lib/db.js --self-test        # самопроверка схемы, триггеров и FTS
node tests/stage0-smoke.js        # smoke этапа 0
node --test tests/<file>.test.js  # отдельный файл
```

## 8. Фикстура

```bash
node tests/site/server.js --port 0
```

Локальный сайт для проверки сканера и фаззера:

- 5 HTML-страниц (`page1.html`…`page5.html`) с цепочкой ссылок на глубину;
- `/admin/`, `/backup.zip`, `/api/v1/status.json`;
- `flag{demo}` в `flag.html`;
- soft-404: неизвестный путь отдаёт `200` с фиксированной страницей — фаззер не должен считать это находкой;
- `robots.txt` с `Disallow: /secret`;
- ссылка на внешний домен для проверки скоупа.

## 9. Архитектура

```
bin/scanner.js        краулер + фаззер, единственный писатель
bin/server.js         статика, WS, поллинг rev каждые 250 мс
lib/norm.js           нормализация URL в key
lib/extract.js        ссылки, формы, src, JS-литералы, sitemap/robots
lib/rules.js          правила находок (flag, секреты, ключи, стектрейсы, TODO)
lib/db.js             доступ к SQLite, запись/чтение
lib/migrate.js        версия схемы и миграции
lib/crawl.js          очередь, robots, лимиты, SIGINT/resume
lib/fuzz.js           словарный фаззинг + soft-404
lib/search.js         FTS5 и regex
lib/refetch.js        повторный запрос по известному ключу
lib/stream.js         снапшоты, дельты по rev, подписчики
web/recon.js          граф, снапшоты, дельты, локальный субграф
web/inspector.js      инспектор узла
web/search.js         поиск, виртуализация, setEmphasis
web/panel.js          форк панели настроек
web/vendor/*          движок Obsidian — не менять (см. VENDOR.md)
```

## 10. Ограничения

Не входит в спеку 1:

- импортёры директории, HAR и JS-бандлов (спека 2);
- дифф сканов, фаззинг параметров, экспорт, метки (спека 3).

Дополнительно:

- тела больше 2 МБ не индексируются в FTS (`fts_truncated=1`);
- `refetch` пишет в БД — единственное исключение из read-only сервера, см. `.crush/state/deviations.md`.

## 11. Troubleshooting

| Симптом | Причина | Что делать |
|---|---|---|
| `node:sqlite` не найден | Node < 22.5 | обновить Node до >= 22.5 |
| Пустой граф | выбран скан без данных | проверить статус скана и `data/scans/` |
| WS не подключается | занятый порт или прокси | сменить `--port`, проверить прокси |
| `better-sqlite3` не реализован | fallback не добавлен | использовать Node >= 22.5 |
