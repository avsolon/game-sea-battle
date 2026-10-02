# Контекст проекта

## Цель
Морской бой для Яндекс Игр: режим против бота + сетевой режим (WS-сервер с комнатами).

## Архитектура
- `server.mjs` — Express (статика `public/`, `/healthz`) + WebSocketServer на `/ws`.
  Комнаты в памяти (`rooms` Map), сессии (`sessions`), очередь быстрого поиска (`quickQueue`).
- `public/shared/rules.mjs` — общие для клиента и сервера правила: флот, `applyAttack`,
  `isFleetDestroyed`, `chooseBotTarget`, `createRandomFleet`. ESM, работает и в Node, и в браузере.
- `public/game.js` — весь клиент (рендер на canvas, бот, сетевой режим).
- `public/config.js` — рантайм-конфиг (`SEA_BATTLE_CONFIG`): `serverUrl`, реклама, `yandexSdk`.
- `public/platform.js` — обёртка над Яндекс SDK (реклама, фуллскрин), деградирует без SDK.
  `shouldLoadYandexSdk()` грузит SDK только внутри Яндекса / в iframe / на localhost.

## Протокол WS (`/ws`)
Клиент -> сервер: `hello{token}` (hex 16..80, обязателен первым), `join{action:create|join|quick|reconnect, code}`,
`place{fleet}`, `fire{x,y}`, `rematch`, `leave`.
Сервер -> клиент: `waiting{code}`, `queued`, `state{...}`, `placementAccepted`, `roomClosed`, `error{code,message}`.

### Важно: семантика `boards` в `state`
`player.attacks` — выстрелы, полученные этим игроком (т.е. сделанные соперником).
Поэтому `boards.self.attacks` = выстрелы **по моей** доске, `boards.opponent.attacks` = **мои** выстрелы.
Клиент обязан маппить инверсно (см. game.js ~1838).

## Текущая задача
Подготовлен деплой на asolontsov.ru: бэкенд-микросервис в Docker + страница
`sea-battle.html` на сайте. Инструкция — `deploy/README-deploy.md`. Сделано 2026-10-02.

## Деплой на asolontsov.ru (ручной, без оркестратора)
Схема: nginx на хосте, все его `proxy_pass` на `localhost`; сайт — приложение на 8081.
Порт 8102 свободен (заняты 22,53,68,80,443,3000,3001,5433,8000,8002,8081-8085,8087-8091,8093,8095,8101).

- `Dockerfile` — node:22-alpine, 2 стадии, пользователь `node`, healthcheck `/healthz`.
- `docker-compose.yml` — сервис `sea-battle` (`sea-battle-backend`),
  публикует **только** `127.0.0.1:8102:3000` (наружу не виден). Порт меняется
  через `SEA_BATTLE_HOST_PORT`. Внешняя сеть не нужна.
- `deploy/nginx/sea-battle-location.conf` — блок для вставки внутрь
  `server { server_name asolontsov.ru ... }`: `location = /sea-battle.html`
  (отдаёт файл из `/var/www/sea-battle`) и `location /sea-battle/` ->
  `proxy_pass http://127.0.0.1:8102/;` со слешем (иначе бэкенд получит
  `/sea-battle/ws` и отвергнет). `Connection "upgrade"` задан в самом location —
  общий `map $http_upgrade` в `http` не нужен.
- `scripts/build-site-bundle.mjs` -> `dist/sea-battle.html`: один автономный файл
  (стили + склеенный JS + картинка в base64), inline-конфиг с `serverUrl` от
  `location.host`. Кладётся в `html/games/sea-battle.html` сайта.
- Пошаговая инструкция и разбор ошибок: `deploy/README-deploy.md`.

## Ключевые файлы
- `server.mjs:50` `isOriginAllowed` — проверка Origin для WS (в prod жёсткая, в dev + приватные подсети).
- `server.mjs:375` `stateForPlayer` — формирование состояния комнаты.
- `server.mjs:774` `handleFire` — серверная валидация выстрела.
- `public/game.js:1838` — маппинг выстрелов из сетевого состояния.
- `public/game.js` `drawShip` — отрисовка корабля (там был баг поворота).
- `public/game.js` `collectBlockedCells` — невозможные клетки вокруг потопленного корабля.
- `tests/rules.test.mjs` — юнит-тесты правил.
- `tests/helpers.mjs` — запуск сервера на случайном порту + WS-клиент с ожиданием по отметке.
- `tests/turn-rule.test.mjs` — правило «попал — ходи снова» и сообщения ранения/потопления.

## Правила игры (актуальные)
- Попадание => ход остаётся у стрелка, передача хода только при промахе.
- Клетки вокруг потопленного корабля помечаются крестиком: корабли не соприкасаются.
- Флаг `sunk` ставится только на последней палубе; все клетки корабля кладутся в `sunkCells`.
- Столбцы доски — буквы А..К (`COLUMN_LABELS`), строки — цифры.