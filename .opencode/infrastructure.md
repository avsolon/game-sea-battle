# Инфраструктура

## Стек
- Node.js >= 20 (проверено: v24.21.0)
- Express 4 (статика + `/healthz`), ws 8 (WebSocket), dotenv 16
- Клиент: ES-модули + `<canvas>`, без сборщика и без фреймворков. Открывается напрямую из `public/`.
- Тесты: встроенный `node --test` (без jest/mocha).

## Запуск
```bash
npm install
npm start          # node server.mjs -> http://0.0.0.0:3000
npm run dev        # с --watch
npm test           # node --test
npm run check      # node --check по server.mjs, platform.js, game.js, rules.mjs
```

## Конфигурация (`.env`, необязательно — есть дефолты)
Файл не создан, достаточно `.env.example`. Переменные:

| Переменная | Дефолт | Назначение |
|---|---|---|
| `PORT` | 3000 | порт HTTP+WS |
| `NODE_ENV` | development | при `production` включается строгая проверка Origin |
| `ALLOWED_ORIGINS` | (только Яндекс) | список origins через запятую, можно `*` |
| `DISCONNECT_GRACE_MS` | 60000 | сколько ждать вернувшийся соперник после разрыва |
| `CORS_ORIGINS` | пусто | allow-list origins для чтения статики с домена бэкенда; пусто = выключено |

## Сеть
Сервер слушает `0.0.0.0` (все интерфейсы) — доступен по LAN без доп. настройки.
Текущий LAN IP машины: `10.54.203.17`.
Проверено: `http://10.54.203.17:3000` отдаёт страницу и принимает WS с
`Origin: http://10.54.203.17:3000` (приватные подсети разрешены в dev).

Если в сети другой адрес — узнать: `ipconfig getifaddr en0` (macOS).
Соседу по сети нужно открыть `http://<ваш-LAN-IP>:3000` и выбрать «Играть по сети».
Если соединение не идёт — проверить, что файрвол не режет порт 3000 и что клиент в той же подсети.

## Прод-деплой на asolontsov.ru (подготовлено, вручную на сервере)
- nginx на хосте, все `proxy_pass` на `localhost`; сайт — приложение на 8081.
- Образ: `Dockerfile` (node:22-alpine, healthcheck `/healthz`, пользователь `node`).
- Контейнер `sea-battle-backend`: `127.0.0.1:8102:3000` — только localhost.
  Порт хоста настраивается `SEA_BATTLE_HOST_PORT` (свободен: 8001, 8003, 8086,
  8092, 8094, 8096-8100, 8102+).
- Маршруты: `/sea-battle.html` -> файл `/var/www/sea-battle/` (отдаёт nginx),
  `/sea-battle/{ws,game.js,styles.css,shared/*,healthz}` -> `127.0.0.1:8102` (префикс срезается).
- Ассеты игры отдаёт Express с `maxAge: 1h` и `Content-Type: application/javascript`
  для `.mjs` — MIME-тип проверен, ES-модули грузятся.
- Инструкция: `deploy/README-deploy.md`. Проверено локально через node-прокси
  с той же семантикой: страница, css, game.js, rules.mjs, banner — 200;
  комната по коду, вход второго игрока, консоль чистая.
- Нужен HTTPS/WSS: для Яндекс Игр в `public/config.js` вписать публичный адрес в `serverUrl`
  (обязателен `wss://`), для локальной разработки оставить пустую строку.
- Комнаты в памяти процесса => при нескольких репликах нужен Redis или sticky sessions.
