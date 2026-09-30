import "dotenv/config";

import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { WebSocketServer, WebSocket } from "ws";

import {
  applyAttack,
  isFleetDestroyed,
  validateFleet
} from "./public/shared/rules.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDirectory = path.join(__dirname, "public");

const port = readInteger(process.env.PORT, 3000);
const nodeEnvironment = process.env.NODE_ENV || "development";
const disconnectGraceMs = readInteger(
  process.env.DISCONNECT_GRACE_MS,
  60000
);

const allowedOrigins = new Set(
  String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean)
);

const defaultYandexOrigins = new Set([
  "https://games.yandex.ru",
  "https://yandex.ru",
  "https://yandex.com",
  "https://yandex.by",
  "https://yandex.kz"
]);

function readInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : fallback;
}

function isOriginAllowed(origin) {
  if (allowedOrigins.has("*")) {
    return true;
  }

  if (!origin) {
    return nodeEnvironment !== "production";
  }

  const normalized = origin.replace(/\/$/, "");

  if (
    allowedOrigins.has(normalized) ||
    defaultYandexOrigins.has(normalized)
  ) {
    return true;
  }

  if (nodeEnvironment !== "production") {
    try {
      const url = new URL(normalized);

      return (
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        isPrivateHostname(url.hostname)
      );
    } catch {
      return false;
    }
  }

  return false;
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase();

  if (host.endsWith(".local") || host.endsWith(".localhost")) {
    return true;
  }

  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);

  if (!match) {
    return false;
  }

  const octets = match.slice(1).map(Number);

  if (octets.some((octet) => octet > 255)) {
    return false;
  }

  const [first, second] = octets;

  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

const app = express();

app.disable("x-powered-by");

app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()"
  );

  next();
});

app.get("/healthz", (_request, response) => {
  response.json({
    ok: true,
    service: "sea-battle",
    time: new Date().toISOString()
  });
});

app.use(
  express.static(publicDirectory, {
    etag: true,
    maxAge: nodeEnvironment === "production" ? "1h" : 0
  })
);

const server = http.createServer(app);

const webSocketServer = new WebSocketServer({
  noServer: true,
  maxPayload: 16 * 1024,
  perMessageDeflate: false
});

server.on("upgrade", (request, socket, head) => {
  let requestUrl;

  try {
    requestUrl = new URL(
      request.url || "/",
      `http://${request.headers.host || "localhost"}`
    );
  } catch {
    socket.destroy();
    return;
  }

  if (
    requestUrl.pathname !== "/ws" ||
    !isOriginAllowed(request.headers.origin)
  ) {
    socket.write(
      "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"
    );
    socket.destroy();
    return;
  }

  webSocketServer.handleUpgrade(
    request,
    socket,
    head,
    (webSocket) => {
      webSocketServer.emit(
        "connection",
        webSocket,
        request
      );
    }
  );
});

const rooms = new Map();
const sessions = new Map();
const quickQueue = [];

const roomLetters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function createRoomCode() {
  let code = "";

  do {
    code = Array.from(
      { length: 5 },
      () =>
        roomLetters[
          Math.floor(Math.random() * roomLetters.length)
        ]
    ).join("");
  } while (rooms.has(code));

  return code;
}

function createPlayer(token, webSocket) {
  return {
    token,
    id: randomUUID().slice(0, 8),
    webSocket,
    connected: true,
    disconnectedAt: null,
    disconnectTimer: null,
    fleet: null,
    attacks: [],
    rematch: false
  };
}

function createRoom(players) {
  const code = createRoomCode();

  const room = {
    code,
    phase: "placing",
    players: new Map(),
    order: [],
    currentToken: null,
    winnerToken: null,
    resultReason: null,
    round: 1,
    events: [],
    createdAt: Date.now(),
    lastActivity: Date.now(),
    emptySince: null,
    graceMs: disconnectGraceMs
  };

  for (const player of players) {
    room.players.set(player.token, player);
    room.order.push(player.token);
  }

  rooms.set(code, room);
  return room;
}

function getOtherPlayer(room, player) {
  for (const candidate of room.players.values()) {
    if (candidate.token !== player.token) {
      return candidate;
    }
  }

  return null;
}

function findMembership(token) {
  for (const room of rooms.values()) {
    const player = room.players.get(token);

    if (player) {
      return { room, player };
    }
  }

  return null;
}

function send(webSocket, payload) {
  if (webSocket?.readyState === WebSocket.OPEN) {
    webSocket.send(JSON.stringify(payload));
  }
}

function sendError(webSocket, code, message) {
  send(webSocket, {
    type: "error",
    code,
    message
  });
}

function bindSession(webSocket, token) {
  const existingSession = sessions.get(token);
  const membership = findMembership(token);

  if (
    existingSession?.webSocket &&
    existingSession.webSocket !== webSocket &&
    existingSession.webSocket.readyState === WebSocket.OPEN
  ) {
    existingSession.webSocket.close(
      4001,
      "Session opened in another tab"
    );
  }

  const session = {
    token,
    webSocket,
    roomCode:
      membership?.room.code ||
      existingSession?.roomCode ||
      null,
    queued: existingSession?.queued || false,
    lastSeen: Date.now()
  };

  sessions.set(token, session);
  webSocket.boundToken = token;

  return session;
}

function removeFromQuickQueue(token) {
  for (let index = quickQueue.length - 1; index >= 0; index -= 1) {
    if (quickQueue[index] === token) {
      quickQueue.splice(index, 1);
    }
  }

  const session = sessions.get(token);

  if (session) {
    session.queued = false;
  }
}

function playerNumber(room, token) {
  const index = room.order.indexOf(token);
  return index >= 0 ? index + 1 : 1;
}

function playerLabel(room, token) {
  return `Игрок ${playerNumber(room, token)}`;
}

function formatCoordinate(x, y) {
  return `${x + 1}:${y + 1}`;
}

function addEvent(room, text) {
  room.events.push({
    text,
    at: Date.now()
  });

  if (room.events.length > 12) {
    room.events.shift();
  }

  room.lastActivity = Date.now();
}

function beginBattle(room, isRematch = false) {
  room.phase = "battle";
  room.currentToken =
    room.order[Math.floor(Math.random() * room.order.length)];
  room.winnerToken = null;
  room.resultReason = null;
  room.lastActivity = Date.now();

  if (!isRematch) {
    room.round = 1;
  }

  for (const player of room.players.values()) {
    player.rematch = false;
  }

  addEvent(
    room,
    isRematch
      ? `Реванш начался. Раунд ${room.round}.`
      : "Корабли расставлены. Бой начался!"
  );
}

function finishRoom(room, winnerToken, reason) {
  if (room.phase === "finished") {
    return;
  }

  room.phase = "finished";
  room.currentToken = null;
  room.winnerToken = winnerToken;
  room.resultReason = reason;
  room.lastActivity = Date.now();

  const winner = room.players.get(winnerToken);
  const winnerName = winner
    ? playerLabel(room, winner.token)
    : "Ничья";

  addEvent(room, `${winnerName} победил.`);
}

function stateForPlayer(room, player) {
  const opponent = getOtherPlayer(room, player);

  let turn = null;

  if (room.phase === "battle") {
    turn =
      room.currentToken === player.token
        ? "self"
        : "opponent";
  }

  let winner = null;

  if (room.winnerToken) {
    winner =
      room.winnerToken === player.token
        ? "self"
        : "opponent";
  }

  return {
    type: "state",
    code: room.code,
    round: room.round,
    phase: room.phase,
    self: {
      id: player.id,
      connected: true,
      ready: Boolean(player.fleet),
      fleet: player.fleet
    },
    opponent: opponent
      ? {
          id: opponent.id,
          connected: opponent.connected,
          ready: Boolean(opponent.fleet),
          disconnectedAt: opponent.disconnectedAt
        }
      : null,
    boards: {
      self: {
        attacks: player.attacks
      },
      opponent: {
        attacks: opponent?.attacks || []
      }
    },
    turn,
    winner,
    resultReason: room.resultReason,
    rematch: {
      self: player.rematch,
      opponent: Boolean(opponent?.rematch)
    },
    disconnectDeadline: opponent && !opponent.connected
      ? opponent.disconnectedAt + room.graceMs
      : null,
    events: room.events.map(({ text, at }) => ({
      text,
      at
    })),
    serverTime: Date.now()
  };
}

function sendState(room, player) {
  send(
    player.webSocket,
    stateForPlayer(room, player)
  );
}

function broadcastRoomState(room) {
  for (const player of room.players.values()) {
    if (player.connected && player.webSocket) {
      sendState(room, player);
    }
  }
}

function sendWaiting(webSocket, room) {
  send(webSocket, {
    type: "waiting",
    code: room.code
  });
}

function reconnectPlayer(webSocket, session, membership) {
  const { room, player } = membership;
  const other = getOtherPlayer(room, player);

  if (
    player.webSocket &&
    player.webSocket !== webSocket &&
    player.webSocket.readyState === WebSocket.OPEN
  ) {
    player.webSocket.close(
      4001,
      "Session reconnected"
    );
  }

  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }

  player.webSocket = webSocket;
  player.connected = true;
  player.disconnectedAt = null;
  session.roomCode = room.code;
  session.lastSeen = Date.now();
  room.lastActivity = Date.now();
  room.emptySince = null;

  // Рассылаем состояние всей комнате, а не только вернувшемуся игроку:
  // иначе у соперника навсегда остаётся opponent.connected === false,
  // и он не может ходить (клиент блокирует выстрел при !opponentConnected).
  if (other) {
    broadcastRoomState(room);
  } else {
    sendWaiting(webSocket, room);
  }
}

function createWaitingRoom(session) {
  removeFromQuickQueue(session.token);

  const player = createPlayer(
    session.token,
    session.webSocket
  );

  const room = createRoom([player]);
  session.roomCode = room.code;

  sendWaiting(session.webSocket, room);
}

function joinPrivateRoom(session, requestedCode) {
  removeFromQuickQueue(session.token);

  const code = String(requestedCode || "")
    .trim()
    .toUpperCase();

  const room = rooms.get(code);

  if (!room) {
    sendError(
      session.webSocket,
      "INVALID_CODE",
      "Комната с таким кодом не найдена."
    );
    return;
  }

  if (room.players.size >= 2) {
    sendError(
      session.webSocket,
      "ROOM_FULL",
      "В комнате уже два игрока."
    );
    return;
  }

  const player = createPlayer(
    session.token,
    session.webSocket
  );

  room.players.set(player.token, player);
  room.order.push(player.token);
  session.roomCode = room.code;
  room.lastActivity = Date.now();
  room.emptySince = null;

  broadcastRoomState(room);
}

function tryMatchQueuedPlayers() {
  while (quickQueue.length >= 2) {
    const firstToken = quickQueue.shift();
    const secondToken = quickQueue.shift();

    const firstSession = sessions.get(firstToken);
    const secondSession = sessions.get(secondToken);

    if (
      !firstSession?.webSocket ||
      firstSession.webSocket.readyState !== WebSocket.OPEN
    ) {
      if (secondSession?.webSocket?.readyState === WebSocket.OPEN) {
        quickQueue.unshift(secondSession.token);
      }
      continue;
    }

    if (
      !secondSession?.webSocket ||
      secondSession.webSocket.readyState !== WebSocket.OPEN
    ) {
      quickQueue.unshift(firstSession.token);
      continue;
    }

    firstSession.queued = false;
    secondSession.queued = false;

    const firstPlayer = createPlayer(
      firstSession.token,
      firstSession.webSocket
    );

    const secondPlayer = createPlayer(
      secondSession.token,
      secondSession.webSocket
    );

    const room = createRoom([
      firstPlayer,
      secondPlayer
    ]);

    firstSession.roomCode = room.code;
    secondSession.roomCode = room.code;

    addEvent(room, "Соперники подключены.");
    broadcastRoomState(room);
  }
}

function joinQuickQueue(session) {
  removeFromQuickQueue(session.token);
  session.queued = true;
  quickQueue.push(session.token);

  send(session.webSocket, {
    type: "queued"
  });

  tryMatchQueuedPlayers();
}

function handleHello(webSocket, message) {
  if (webSocket.boundToken) {
    sendError(
      webSocket,
      "ALREADY_INITIALIZED",
      "Соединение уже инициализировано."
    );
    return;
  }

  const token = String(message.token || "");

  if (
    token.length < 16 ||
    token.length > 80 ||
    !/^[a-f0-9-]+$/i.test(token)
  ) {
    sendError(
      webSocket,
      "INVALID_TOKEN",
      "Некорректный анонимный токен."
    );
    return;
  }

  bindSession(webSocket, token);
}

function handleJoin(webSocket, message) {
  const session = sessions.get(webSocket.boundToken);

  if (!session) {
    sendError(
      webSocket,
      "NO_SESSION",
      "Сначала необходимо отправить hello."
    );
    return;
  }

  session.lastSeen = Date.now();

  const membership = findMembership(session.token);
  const action = String(message.action || "reconnect");

  if (membership) {
    reconnectPlayer(
      webSocket,
      session,
      membership
    );
    return;
  }

  switch (action) {
    case "create":
      createWaitingRoom(session);
      break;

    case "join":
      joinPrivateRoom(
        session,
        message.code
      );
      break;

    case "quick":
      joinQuickQueue(session);
      break;

    case "reconnect":
      sendError(
        webSocket,
        "ROOM_NOT_FOUND",
        "Активная комната не найдена."
      );
      break;

    default:
      sendError(
        webSocket,
        "INVALID_ACTION",
        "Неизвестное действие подключения."
      );
  }
}

function handlePlace(webSocket, message) {
  const session = sessions.get(webSocket.boundToken);
  const membership = session
    ? findMembership(session.token)
    : null;

  if (!membership) {
    sendError(
      webSocket,
      "NOT_IN_ROOM",
      "Комната не найдена."
    );
    return;
  }

  const { room, player } = membership;

  if (room.phase !== "placing") {
    sendError(
      webSocket,
      "INVALID_PHASE",
      "Сейчас нельзя менять расстановку."
    );
    return;
  }

  if (player.fleet) {
    sendError(
      webSocket,
      "ALREADY_PLACED",
      "Ваш флот уже отправлен."
    );
    return;
  }

  let fleet;

  try {
    fleet = validateFleet(message.fleet);
  } catch (error) {
    sendError(
      webSocket,
      "INVALID_FLEET",
      error instanceof Error
        ? error.message
        : "Некорректный флот."
    );
    return;
  }

  player.fleet = fleet;
  room.lastActivity = Date.now();

  send(webSocket, {
    type: "placementAccepted"
  });

  const opponent = getOtherPlayer(room, player);

  if (opponent?.fleet) {
    beginBattle(room);
    broadcastRoomState(room);
  }
}

function handleFire(webSocket, message) {
  const session = sessions.get(webSocket.boundToken);
  const membership = session
    ? findMembership(session.token)
    : null;

  if (!membership) {
    sendError(
      webSocket,
      "NOT_IN_ROOM",
      "Комната не найдена."
    );
    return;
  }

  const { room, player } = membership;

  if (room.phase !== "battle") {
    sendError(
      webSocket,
      "INVALID_PHASE",
      "Бой ещё не начался."
    );
    return;
  }

  if (room.currentToken !== player.token) {
    sendError(
      webSocket,
      "NOT_YOUR_TURN",
      "Сейчас ход соперника."
    );
    return;
  }

  const defender = getOtherPlayer(room, player);

  if (
    !defender?.fleet ||
    !defender.connected
  ) {
    sendError(
      webSocket,
      "OPPONENT_UNAVAILABLE",
      "Соперник временно недоступен."
    );
    return;
  }

  let result;

  try {
    result = applyAttack(
      defender.fleet,
      defender.attacks,
      message.x,
      message.y
    );
  } catch (error) {
    sendError(
      webSocket,
      "INVALID_ATTACK",
      error instanceof Error
        ? error.message
        : "Некорректный выстрел."
    );
    return;
  }

  const coordinate = formatCoordinate(
    result.x,
    result.y
  );

  const attackerName = playerLabel(
    room,
    player.token
  );

  if (result.result === "miss") {
    addEvent(
      room,
      `${attackerName}: выстрел в ${coordinate} — мимо.`
    );
  } else if (result.sunk) {
    addEvent(
      room,
      `${attackerName}: попадание в ${coordinate}, корабль уничтожен!`
    );
  } else {
    addEvent(
      room,
      `${attackerName}: попадание в ${coordinate}.`
    );
  }

  if (isFleetDestroyed(defender.fleet, defender.attacks)) {
    finishRoom(
      room,
      player.token,
      "Все корабли соперника уничтожены."
    );
  } else {
    room.currentToken = defender.token;
  }

  room.lastActivity = Date.now();
  broadcastRoomState(room);
}

function handleRematch(webSocket) {
  const session = sessions.get(webSocket.boundToken);
  const membership = session
    ? findMembership(session.token)
    : null;

  if (!membership) {
    sendError(
      webSocket,
      "NOT_IN_ROOM",
      "Комната не найдена."
    );
    return;
  }

  const { room, player } = membership;

  if (room.phase !== "finished") {
    sendError(
      webSocket,
      "INVALID_PHASE",
      "Реванш доступен только после окончания боя."
    );
    return;
  }

  player.rematch = true;
  room.lastActivity = Date.now();

  const players = [...room.players.values()];
  const everyoneReady = players.every(
    (candidate) => candidate.rematch
  );

  if (everyoneReady) {
    for (const candidate of players) {
      candidate.attacks = [];
      candidate.rematch = false;
    }

    room.round += 1;
    beginBattle(room, true);
  }

  broadcastRoomState(room);
}

function handleLeave(webSocket) {
  const session = sessions.get(webSocket.boundToken);

  if (!session) {
    return;
  }

  removeFromQuickQueue(session.token);

  const membership = findMembership(session.token);

  if (!membership) {
    session.roomCode = null;
    return;
  }

  const { room, player } = membership;
  const opponent = getOtherPlayer(room, player);

  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
  }

  room.players.delete(player.token);
  session.roomCode = null;
  session.lastSeen = Date.now();

  if (opponent?.webSocket) {
    send(opponent.webSocket, {
      type: "roomClosed",
      message: "Соперник покинул комнату."
    });
  }

  if (room.players.size === 0) {
    rooms.delete(room.code);
  } else {
    room.lastActivity = Date.now();
  }
}

function markPlayerDisconnected(session) {
  removeFromQuickQueue(session.token);

  const membership = findMembership(session.token);

  if (!membership) {
    return;
  }

  const { room, player } = membership;
  const opponent = getOtherPlayer(room, player);

  player.connected = false;
  player.webSocket = null;
  player.disconnectedAt = Date.now();

  session.lastSeen = Date.now();
  room.lastActivity = Date.now();

  if (!opponent) {
    rooms.delete(room.code);
    session.roomCode = null;
    return;
  }

  broadcastRoomState(room);

  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
  }

  player.disconnectTimer = setTimeout(() => {
    if (
      !rooms.has(room.code) ||
      player.connected
    ) {
      return;
    }

    const currentOpponent = getOtherPlayer(
      room,
      player
    );

    if (
      room.phase !== "finished" &&
      currentOpponent
    ) {
      finishRoom(
        room,
        currentOpponent.token,
        "Соперник не вернулся вовремя."
      );

      broadcastRoomState(room);
    }

    room.lastActivity = Date.now();

    const hasConnectedPlayer = [...room.players.values()]
      .some((candidate) => candidate.connected);

    room.emptySince = hasConnectedPlayer
      ? null
      : Date.now();
  }, room.graceMs);
}

function consumeMessageBudget(webSocket) {
  const now = Date.now();
  const elapsedSeconds = Math.max(
    0,
    (now - webSocket.rateLast) / 1000
  );

  webSocket.rateTokens = Math.min(
    30,
    webSocket.rateTokens + elapsedSeconds * 12
  );

  webSocket.rateLast = now;

  if (webSocket.rateTokens < 1) {
    return false;
  }

  webSocket.rateTokens -= 1;
  return true;
}

webSocketServer.on(
  "connection",
  (webSocket, request) => {
    webSocket.isAlive = true;
    webSocket.rateTokens = 30;
    webSocket.rateLast = Date.now();

    webSocket.on("pong", () => {
      webSocket.isAlive = true;
    });

    webSocket.on("message", (rawData) => {
      if (!consumeMessageBudget(webSocket)) {
        sendError(
          webSocket,
          "RATE_LIMIT",
          "Слишком много запросов."
        );

        webSocket.close(1008, "Rate limit");
        return;
      }

      let message;

      try {
        message = JSON.parse(
          rawData.toString("utf8")
        );
      } catch {
        sendError(
          webSocket,
          "INVALID_JSON",
          "Некорректное сообщение."
        );
        return;
      }

      if (
        !message ||
        typeof message !== "object" ||
        typeof message.type !== "string"
      ) {
        sendError(
          webSocket,
          "INVALID_MESSAGE",
          "Некорректное сообщение."
        );
        return;
      }

      switch (message.type) {
        case "hello":
          handleHello(webSocket, message);
          break;

        case "join":
          handleJoin(webSocket, message);
          break;

        case "place":
          handlePlace(webSocket, message);
          break;

        case "fire":
          handleFire(webSocket, message);
          break;

        case "rematch":
          handleRematch(webSocket);
          break;

        case "leave":
          handleLeave(webSocket);
          break;

        default:
          sendError(
            webSocket,
            "UNKNOWN_MESSAGE",
            "Неизвестный тип сообщения."
          );
      }
    });

    webSocket.on("close", () => {
      const token = webSocket.boundToken;
      const session = token
        ? sessions.get(token)
        : null;

      if (
        !session ||
        session.webSocket !== webSocket
      ) {
        return;
      }

      session.webSocket = null;
      session.lastSeen = Date.now();

      markPlayerDisconnected(session);
    });

    webSocket.on("error", () => {
      // Ошибка транспорта обрабатывается событием close.
    });
  }
);

const heartbeatInterval = setInterval(() => {
  for (const webSocket of webSocketServer.clients) {
    if (!webSocket.isAlive) {
      webSocket.terminate();
      continue;
    }

    webSocket.isAlive = false;
    webSocket.ping();
  }
}, 30000);

const cleanupInterval = setInterval(() => {
  const now = Date.now();

  for (const session of sessions.values()) {
    if (
      !session.webSocket &&
      !findMembership(session.token) &&
      now - session.lastSeen > 10 * 60 * 1000
    ) {
      sessions.delete(session.token);
    }
  }

  for (let index = quickQueue.length - 1; index >= 0; index -= 1) {
    const token = quickQueue[index];
    const session = sessions.get(token);

    if (
      !session?.webSocket ||
      session.webSocket.readyState !== WebSocket.OPEN
    ) {
      quickQueue.splice(index, 1);
    }
  }

  for (const room of rooms.values()) {
    const connectedPlayers = [...room.players.values()]
      .filter((player) => player.connected);

    if (connectedPlayers.length === 0) {
      if (!room.emptySince) {
        room.emptySince = now;
      }

      if (
        room.emptySince &&
        now - room.emptySince > 10 * 60 * 1000
      ) {
        rooms.delete(room.code);
      }
    } else {
      room.emptySince = null;
    }
  }
}, 60000);

heartbeatInterval.unref();
cleanupInterval.unref();

server.listen(port, "0.0.0.0", () => {
  console.log(
    `Sea Battle server listening on port ${port}`
  );
});

function shutdown() {
  clearInterval(heartbeatInterval);
  clearInterval(cleanupInterval);

  for (const webSocket of webSocketServer.clients) {
    webSocket.close(1001, "Server shutdown");
  }

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);