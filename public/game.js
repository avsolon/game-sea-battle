import {
  BOARD_SIZE,
  FLEET_LAYOUT,
  applyAttack,
  canPlaceShip,
  chooseBotTarget,
  createRandomFleet,
  getShipAt,
  isFleetDestroyed,
  validateFleet
} from "./shared/rules.mjs";

import {
  createPlatform
} from "./platform.js";

const $ = (id) =>
  document.getElementById(id);

const elements = {
  loadingScreen: $("loadingScreen"),
  app: $("app"),

  menuScreen: $("menuScreen"),
  botModeButton: $("botModeButton"),
  onlineModeButton: $("onlineModeButton"),

  onlineLobby: $("onlineLobby"),
  onlineDot: $("onlineDot"),
  onlineStatus: $("onlineStatus"),
  quickMatchButton: $("quickMatchButton"),
  createRoomButton: $("createRoomButton"),
  joinCodeInput: $("joinCodeInput"),
  joinRoomButton: $("joinRoomButton"),
  joinRoomForm: $("joinRoomForm"),

  roomBox: $("roomBox"),
  roomCode: $("roomCode"),
  copyRoomCodeButton: $("copyRoomCodeButton"),
  cancelRoomButton: $("cancelRoomButton"),
  backFromOnlineButton: $("backFromOnlineButton"),

  gameScreen: $("gameScreen"),
  exitButton: $("exitButton"),
  modeBadge: $("modeBadge"),
  roomBadge: $("roomBadge"),
  soundButton: $("soundButton"),
  soundButtonText: $("soundButtonText"),
  fullscreenButton: $("fullscreenButton"),

  statusBanner: $("statusBanner"),
  statusText: $("statusText"),
  disconnectText: $("disconnectText"),

  mobileBoardTabs: $("mobileBoardTabs"),

  playerPane: $("playerPane"),
  playerTitle: $("playerTitle"),
  playerSubtitle: $("playerSubtitle"),
  playerCanvas: $("playerCanvas"),

  enemyPane: $("enemyPane"),
  enemyTitle: $("enemyTitle"),
  enemySubtitle: $("enemySubtitle"),
  enemyCanvas: $("enemyCanvas"),

  placementPanel: $("placementPanel"),
  placementBadge: $("placementBadge"),
  fleetTray: $("fleetTray"),
  rotateButton: $("rotateButton"),
  randomFleetButton: $("randomFleetButton"),
  clearFleetButton: $("clearFleetButton"),
  readyButton: $("readyButton"),
  placementHint: $("placementHint"),

  tipText: $("tipText"),
  eventLog: $("eventLog"),

  resultOverlay: $("resultOverlay"),
  resultTitle: $("resultTitle"),
  resultText: $("resultText"),
  resultPrimaryButton: $("resultPrimaryButton"),
  resultSecondaryButton: $("resultSecondaryButton"),

  toast: $("toast")
};

const runtimeConfig =
  window.SEA_BATTLE_CONFIG || {};

const adEveryRounds = Math.max(
  1,
  Number(runtimeConfig.fullscreenAdEveryRounds) || 3
);

const platform = createPlatform();
const mobileMedia = window.matchMedia(
  "(max-width: 780px), (orientation: portrait)"
);

const CANVAS_SIZE = 900;
const BOARD_PADDING = 40;
const CELL_SIZE = 82;
const BOARD_RENDER_SIZE = CELL_SIZE * BOARD_SIZE;

const state = {
  mode: null,
  phase: "placing",

  playerFleet: [],
  enemyFleet: null,

  playerAttacks: [],
  enemyAttacks: [],

  selectedSize: 4,
  horizontal: true,

  turn: null,
  winner: null,
  resultReason: null,

  round: 1,
  logs: [],

  roomCode: "",
  opponentConnected: true,
  disconnectDeadline: null,

  submittedFleet: false,
  rematchSelf: false,
  rematchOpponent: false,

  actionLocked: false,

  hover: {
    player: null,
    enemy: null
  },

  activeMobileBoard: "player",

  resultKey: null
};

let shipSequence = 0;
let botTimer = null;
let botEpoch = 0;
let toastTimer = null;
let soundEnabled = readLocalBoolean("seaBattleSound", true);
let audioContext = null;
let roundsSinceAd = 0;
let lastAdAt = 0;
let animationFrame = null;
let animateRenderUntil = 0;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readLocalBoolean(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);

    if (value === null) {
      return fallback;
    }

    return value === "true";
  } catch {
    return fallback;
  }
}

function writeLocalBoolean(key, value) {
  try {
    window.localStorage.setItem(
      key,
      String(value)
    );
  } catch {
    // Игра работает и при запрещённом localStorage.
  }
}

function readSession(key) {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key, value) {
  try {
    window.sessionStorage.setItem(
      key,
      value
    );
  } catch {
    // Игра работает и при запрещённом sessionStorage.
  }
}

function deleteSession(key) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Игнорировать.
  }
}

function createAnonymousToken() {
  if (
    window.crypto?.randomUUID
  ) {
    return window.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);

  window.crypto.getRandomValues(bytes);

  return Array.from(
    bytes,
    (value) =>
      value.toString(16).padStart(2, "0")
  ).join("");
}

function getWebSocketUrl() {
  const configuredUrl = String(
    runtimeConfig.serverUrl || ""
  ).trim();

  if (configuredUrl) {
    return configuredUrl;
  }

  if (!window.location.host) {
    throw new Error(
      "Не удалось определить адрес WebSocket-сервера."
    );
  }

  const protocol =
    window.location.protocol === "https:"
      ? "wss:"
      : "ws:";

  return `${protocol}//${window.location.host}/ws`;
}

function showToast(message, duration = 2600) {
  clearTimeout(toastTimer);

  elements.toast.textContent = message;
  elements.toast.classList.add("visible");

  toastTimer = setTimeout(() => {
    elements.toast.classList.remove("visible");
  }, duration);
}

function getAudioContext() {
  if (!soundEnabled) {
    return null;
  }

  const AudioContextClass =
    window.AudioContext ||
    window.webkitAudioContext;

  if (!AudioContextClass) {
    return null;
  }

  if (!audioContext) {
    audioContext = new AudioContextClass();
  }

  return audioContext;
}

async function unlockAudio() {
  if (!soundEnabled) {
    return;
  }

  try {
    const context = getAudioContext();

    if (
      context?.state === "suspended"
    ) {
      await context.resume();
    }
  } catch {
    // Звук остаётся необязательным.
  }
}

function playTone(
  context,
  startAt,
  frequency,
  duration,
  type   = "sine",
  volume = 0.04
) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = type;
  oscillator.frequency.setValueAtTime(
    frequency,
    startAt
  );

  oscillator.frequency.exponentialRampToValueAtTime(
    Math.max(50, frequency * 0.8),
    startAt + duration
  );

  gain.gain.setValueAtTime(
    0.0001,
    startAt
  );

  gain.gain.exponentialRampToValueAtTime(
    volume,
    startAt + 0.012
  );

  gain.gain.exponentialRampToValueAtTime(
    0.0001,
    startAt + duration
  );

  oscillator.connect(gain);
  gain.connect(context.destination);

  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
}

function playSound(name) {
  if (!soundEnabled) {
    return;
  }

  const context = getAudioContext();

  if (
    !context ||
    context.state !== "running"
  ) {
    return;
  }

  const patterns = {
    place: [
      [250, 0.06, "sine", 0.035],
      [390, 0.07, "sine", 0.03]
    ],
    rotate: [
      [330, 0.055, "triangle", 0.03]
    ],
    hit: [
      [170, 0.09, "sawtooth", 0.045],
      [105, 0.14, "square", 0.025]
    ],
    miss: [
      [135, 0.09, "sine", 0.028],
      [95, 0.11, "sine", 0.02]
    ],
    win: [
      [392, 0.12, "sine", 0.04],
      [494, 0.12, "sine", 0.04],
      [659, 0.2, "sine", 0.045]
    ],
    lose: [
      [260, 0.16, "triangle", 0.035],
      [195, 0.17, "triangle", 0.035],
      [130, 0.25, "sine", 0.03]
    ],
    button: [
      [420, 0.045, "sine", 0.02]
    ]
  };

  const pattern = patterns[name] || patterns.button;
  let startAt = context.currentTime;

  for (const tone of pattern) {
    playTone(
      context,
      startAt,
      tone[0],
      tone[1],
      tone[2],
      tone[3]
    );

    startAt += tone[1] + 0.02;
  }
}

class OnlineClient {
  constructor(callbacks) {
    this.callbacks = callbacks;

    const savedToken =
      readSession("seaBattleToken");

    this.token =
      savedToken &&
      savedToken.length >= 16 &&
      savedToken.length <= 80
        ? savedToken
        : createAnonymousToken();

    writeSession(
      "seaBattleToken",
      this.token
    );

    this.webSocket = null;
    this.wanted = false;
    this.manualClose = false;
    this.connected = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;

    this.queued = false;
    this.joining = false;
    this.inRoom = false;
    this.roomCode = "";
    this.generation = 0;
  }

  get mayHaveRoom() {
    return (
      readSession("seaBattleMayHaveRoom") ===
      "true"
    );
  }

  setMayHaveRoom(value) {
    if (value) {
      writeSession(
        "seaBattleMayHaveRoom",
        "true"
      );
    } else {
      deleteSession(
        "seaBattleMayHaveRoom"
      );
    }
  }

  setRoomCode(code) {
    this.roomCode = String(code || "");
    this.inRoom = Boolean(this.roomCode);
    this.setMayHaveRoom(this.inRoom);
  }

  clearRoom() {
    this.roomCode = "";
    this.inRoom = false;
    this.queued = false;
    this.joining = false;
    this.setMayHaveRoom(false);
  }

  connect() {
    this.wanted = true;
    this.manualClose = false;
    this.joining = false;

    clearTimeout(this.reconnectTimer);

    if (
      this.webSocket?.readyState ===
      WebSocket.OPEN
    ) {
      return;
    }

    if (
      this.webSocket?.readyState ===
      WebSocket.CONNECTING
    ) {
      return;
    }

    let url;

    try {
      url = getWebSocketUrl();
    } catch (error) {
      this.callbacks.onStatus?.(
        error instanceof Error
          ? error.message
          : "Неверный адрес сервера.",
        "error"
      );
      return;
    }

    if (!("WebSocket" in window)) {
      this.callbacks.onStatus?.(
        "Этот браузер не поддерживает WebSocket.",
        "error"
      );
      return;
    }

    const generation = ++this.generation;

    let webSocket;

    try {
      webSocket = new WebSocket(url);
    } catch {
      this.callbacks.onStatus?.(
        "Не удалось открыть сетевое соединение.",
        "error"
      );
      return;
    }

    this.webSocket = webSocket;
    this.connected = false;

    this.callbacks.onStatus?.(
      "Подключение к серверу…",
      "connecting"
    );

    webSocket.addEventListener(
      "open",
      () => {
        if (
          generation !== this.generation ||
          this.webSocket !== webSocket
        ) {
          return;
        }

        this.connected = true;
        this.reconnectAttempt = 0;
        this.joining = false;

        this.send({
          type: "hello",
          token: this.token
        });

        if (
          this.roomCode ||
          this.mayHaveRoom
        ) {
          this.send({
            type: "join",
            action: "reconnect"
          });
        }
      }
    );

    webSocket.addEventListener(
      "message",
      (event) => {
        if (
          generation !== this.generation ||
          this.webSocket !== webSocket
        ) {
          return;
        }

        let message;

        try {
          message = JSON.parse(
            event.data
          );
        } catch {
          return;
        }

        this.handleMessage(message);
      }
    );

    webSocket.addEventListener(
      "close",
      () => {
        if (
          generation !== this.generation ||
          this.webSocket !== webSocket
        ) {
          return;
        }

        this.connected = false;
        this.joining = false;

        if (this.queued) {
          this.queued = false;
        }

        this.callbacks.onStatus?.(
          this.wanted
            ? "Соединение потеряно. Повторное подключение…"
            : "Соединение закрыто.",
          this.wanted
            ? "connecting"
            : "closed"
        );

        if (this.wanted) {
          this.scheduleReconnect();
        }
      }
    );

    webSocket.addEventListener(
      "error",
      () => {
        if (
          generation === this.generation
        ) {
          this.callbacks.onStatus?.(
            "Ошибка сетевого соединения.",
            "error"
          );
        }
      }
    );
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);

    const delay = Math.min(
      8000,
      750 *
        2 **
          this.reconnectAttempt
    );

    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(
      () => {
        if (this.wanted) {
          this.connect();
        }
      },
      delay
    );
  }

  handleMessage(message) {
    if (!message?.type) {
      return;
    }

    switch (message.type) {
      case "queued":
        this.queued = true;
        this.joining = false;
        this.clearRoom();
        this.callbacks.onQueued?.();
        break;

      case "waiting":
        this.queued = false;
        this.joining = false;
        this.setRoomCode(message.code);
        this.callbacks.onWaiting?.(
          message
        );
        break;

      case "state":
        this.queued = false;
        this.joining = false;
        this.setRoomCode(message.code);
        this.callbacks.onState?.(
          message
        );
        break;

      case "placementAccepted":
        this.callbacks.onPlacementAccepted?.();
        break;

      case "roomClosed":
        this.clearRoom();
        this.callbacks.onRoomClosed?.(
          message
        );
        break;

      case "error":
        this.joining = false;

        if (
          message.code ===
          "ROOM_NOT_FOUND"
        ) {
          this.clearRoom();
        }

        this.callbacks.onError?.(
          message
        );
        break;

      default:
        break;
    }
  }

  send(packet) {
    if (
      this.webSocket?.readyState !==
      WebSocket.OPEN
    ) {
      return false;
    }

    try {
      this.webSocket.send(
        JSON.stringify(packet)
      );
      return true;
    } catch {
      return false;
    }
  }

  join(action, code = "") {
    if (
      this.inRoom ||
      this.queued
    ) {
      return;
    }

    this.joining = true;
    this.clearRoom();

    const packet = {
      type: "join",
      action
    };

    if (code) {
      packet.code = code;
    }

    if (this.connected) {
      this.send(packet);
    } else {
      this.pendingJoin = packet;
      this.connect();
    }
  }

  sendAction(type, payload = {}) {
    return this.send({
      type,
      ...payload
    });
  }

  leave() {
    this.wanted = false;
    this.manualClose = true;
    this.connected = false;
    this.joining = false;

    clearTimeout(this.reconnectTimer);

    if (
      this.webSocket?.readyState ===
      WebSocket.OPEN
    ) {
      this.send({
        type: "leave"
      });

      this.webSocket.close(
        1000,
        "Client left"
      );
    }

    this.webSocket = null;
    this.clearRoom();
  }
}

const onlineClient = new OnlineClient({
  onStatus(message, kind) {
    setOnlineStatus(
      message,
      kind
    );
  },

  onQueued() {
    elements.roomBox.hidden = true;

    setOnlineStatus(
      "Ищем подходящего соперника…",
      "connecting"
    );

    updateLobbyControls();
  },

  onWaiting(message) {
    elements.roomBox.hidden = false;
    elements.roomCode.textContent =
      message.code || "";

    setOnlineStatus(
      "Комната создана. Ожидаем соперника.",
      "connected"
    );

    updateLobbyControls();
  },

  onState(message) {
    applyOnlineState(message);
  },

  onPlacementAccepted() {
    state.submittedFleet = true;
    state.actionLocked = false;

    elements.placementBadge.textContent =
      "Флот принят сервером";

    updateAll();
  },

  onError(message) {
    state.actionLocked = false;

    if (
      message.code ===
      "INVALID_FLEET"
    ) {
      state.submittedFleet = false;
    }

    if (
      message.code ===
      "ALREADY_PLACED"
    ) {
      state.submittedFleet = true;
    }

    const roomWasLost =
      message.code ===
        "ROOM_NOT_FOUND" ||
      message.code ===
        "NOT_IN_ROOM";

    if (roomWasLost) {
      returnToLobby(
        message.message ||
          "Сетевая комната недоступна."
      );
      return;
    }

    setOnlineStatus(
      message.message ||
        "Ошибка сети.",
      "error"
    );

    updateLobbyControls();
    updateAll();

    showToast(
      message.message ||
        "Ошибка сети."
    );
  },

  onRoomClosed(message) {
    returnToLobby(
      message.message ||
        "Соперник покинул комнату."
    );
  }
});

function setOnlineStatus(
  message,
  kind = "connecting"
) {
  elements.onlineStatus.textContent =
    message;

  elements.onlineDot.classList.remove(
    "connected",
    "error"
  );

  if (kind === "connected") {
    elements.onlineDot.classList.add(
      "connected"
    );
  } else if (kind === "error") {
    elements.onlineDot.classList.add(
      "error"
    );
  }

  updateLobbyControls();
}

function updateLobbyControls() {
  const busy =
    !onlineClient.connected ||
    onlineClient.queued ||
    onlineClient.joining ||
    onlineClient.inRoom;

  elements.quickMatchButton.disabled =
    busy;

  elements.createRoomButton.disabled =
    busy;

  elements.joinRoomButton.disabled =
    busy;

  elements.joinCodeInput.disabled =
    busy;

  elements.cancelRoomButton.disabled =
    !onlineClient.connected;
}

function sanitizeRoomCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 5);
}

async function copyRoomCode() {
  const code =
    elements.roomCode.textContent;

  if (!code) {
    return;
  }

  try {
    await navigator.clipboard.writeText(
      code
    );

    showToast(
      "Код комнаты скопирован."
    );
  } catch {
    const textArea =
      document.createElement("textarea");

    textArea.value = code;
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";

    document.body.appendChild(textArea);
    textArea.select();

    try {
      document.execCommand("copy");
      showToast(
        "Код комнаты скопирован."
      );
    } catch {
      showToast(
        `Код комнаты: ${code}`
      );
    } finally {
      textArea.remove();
    }
  }
}

function openOnlineLobby() {
  platform.gameplayStop();

  elements.menuScreen.hidden = false;
  elements.gameScreen.hidden = true;
  elements.resultOverlay.hidden = true;
  elements.onlineLobby.hidden = false;

  setOnlineStatus(
    "Подключение…",
    "connecting"
  );

  onlineClient.connect();
}

function returnToLobby(message) {
  botEpoch += 1;
  clearTimeout(botTimer);

  onlineClient.clearRoom();

  state.mode = null;
  state.phase = "placing";
  state.playerFleet = [];
  state.enemyFleet = null;
  state.playerAttacks = [];
  state.enemyAttacks = [];
  state.turn = null;
  state.winner = null;
  state.resultKey = null;
  state.submittedFleet = false;
  state.actionLocked = false;

  platform.gameplayStop();

  elements.menuScreen.hidden = false;
  elements.gameScreen.hidden = true;
  elements.resultOverlay.hidden = true;
  elements.onlineLobby.hidden = false;
  elements.roomBox.hidden = true;

  setOnlineStatus(
    message,
    "error"
  );

  showToast(message);
}

function returnToMenu(
  askForConfirmation = true
) {
  const isActiveBattle =
    !elements.gameScreen.hidden &&
    state.phase === "battle";

  if (
    askForConfirmation &&
    isActiveBattle
  ) {
    const confirmed = window.confirm(
      "Покинуть текущий бой? Результат не будет сохранён."
    );

    if (!confirmed) {
      return;
    }
  }

  botEpoch += 1;
  clearTimeout(botTimer);

  onlineClient.leave();

  platform.gameplayStop();

  state.mode = null;
  state.phase = "placing";
  state.playerFleet = [];
  state.enemyFleet = null;
  state.playerAttacks = [];
  state.enemyAttacks = [];
  state.turn = null;
  state.winner = null;
  state.resultReason = null;
  state.resultKey = null;
  state.submittedFleet = false;
  state.rematchSelf = false;
  state.rematchOpponent = false;
  state.actionLocked = false;
  state.roomCode = "";
  state.opponentConnected = true;
  state.disconnectDeadline = null;

  elements.menuScreen.hidden = false;
  elements.gameScreen.hidden = true;
  elements.onlineLobby.hidden = true;
  elements.roomBox.hidden = true;
  elements.resultOverlay.hidden = true;

  void maybeShowFullscreenAd();
}

function revealGameScreen() {
  elements.app.hidden = false;
  elements.menuScreen.hidden = true;
  elements.onlineLobby.hidden = true;
  elements.gameScreen.hidden = false;
}

function resetGameState(mode) {
  botEpoch += 1;
  clearTimeout(botTimer);

  state.mode = mode;
  state.phase = "placing";
  state.playerFleet = [];
  state.enemyFleet = null;
  state.playerAttacks = [];
  state.enemyAttacks = [];
  state.turn = null;
  state.winner = null;
  state.resultReason = null;
  state.round = 1;
  state.logs = [];
  state.selectedSize = 4;
  state.horizontal = true;
  state.submittedFleet = false;
  state.rematchSelf = false;
  state.rematchOpponent = false;
  state.actionLocked = false;
  state.opponentConnected = true;
  state.disconnectDeadline = null;
  state.resultKey = null;

  state.hover.player = null;
  state.hover.enemy = null;

  elements.resultOverlay.hidden = true;
  elements.roomBadge.hidden = true;
  elements.roomBadge.textContent = "";

  if (mode === "bot") {
    addLog(
      "Расставьте флот и нажмите «Я готов»."
    );
  }

  revealGameScreen();

  platform.gameplayStart();

  state.activeMobileBoard = "player";

  updateAll();
}

function startBotGame() {
  onlineClient.leave();
  resetGameState("bot");
}

function canEditPlacement() {
  return (
    state.phase === "placing" &&
    !(
      state.mode === "online" &&
      state.submittedFleet
    )
  );
}

function getFleetCounts() {
  const counts = new Map(
    FLEET_LAYOUT.map(
      (definition) => [
        definition.size,
        definition.count
      ]
    )
  );

  for (const ship of state.playerFleet) {
    counts.set(
      ship.cells.length,
      Math.max(
        0,
        counts.get(ship.cells.length) - 1
      )
    );
  }

  return counts;
}

function normalizeSelectedSize() {
  const remaining =
    getFleetCounts();

  const currentRemaining =
    state.selectedSize == null
      ? 0
      : remaining.get(
          state.selectedSize
        ) || 0;

  if (
    state.selectedSize != null &&
    currentRemaining > 0
  ) {
    return;
  }

  const nextDefinition =
    FLEET_LAYOUT.find(
      (definition) =>
        (remaining.get(definition.size) || 0) >
        0
    );

  state.selectedSize =
    nextDefinition?.size ?? null;
}

function getCandidateCells(x, y) {
  const size =
    state.selectedSize;

  if (
    size == null ||
    !Number.isInteger(x) ||
    !Number.isInteger(y)
  ) {
    return null;
  }

  return Array.from(
    { length: size },
    (_, index) => ({
      x: state.horizontal
        ? x + index
        : x,
      y: state.horizontal
        ? y
        : y + index
    })
  );
}

function candidateFits(cells) {
  if (!cells) {
    return false;
  }

  return cells.every(
    (cell) =>
      cell.x >= 0 &&
      cell.y >= 0 &&
      cell.x < BOARD_SIZE &&
      cell.y < BOARD_SIZE
  );
}

function addLog(text) {
  state.logs.push(text);

  if (state.logs.length > 8) {
    state.logs.shift();
  }
}

function placeAt(x, y) {
  if (
    !canEditPlacement() ||
    state.actionLocked
  ) {
    return;
  }

  const existingShip =
    getShipAt(
      state.playerFleet,
      x,
      y
    );

  if (existingShip) {
    state.playerFleet =
      state.playerFleet.filter(
        (ship) =>
          ship.id !==
          existingShip.id
      );

    normalizeSelectedSize();

    playSound("rotate");
    updateAll();
    return;
  }

  normalizeSelectedSize();

  const cells =
    getCandidateCells(x, y);

  if (
    !candidateFits(cells) ||
    !canPlaceShip(
      cells,
      state.playerFleet
    )
  ) {
    showToast(
      "Здесь корабль не помещается: проверьте границы и соседние клетки."
    );
    return;
  }

  const ship = {
    id: `local-${++shipSequence}`,
    cells
  };

  state.playerFleet.push(ship);

  normalizeSelectedSize();
  playSound("place");

  updateAll();
}

function removeShipAt(x, y) {
  if (!canEditPlacement()) {
    return;
  }

  const ship = getShipAt(
    state.playerFleet,
    x,
    y
  );

  if (!ship) {
    return;
  }

  state.playerFleet =
    state.playerFleet.filter(
      (candidate) =>
        candidate.id !== ship.id
    );

  normalizeSelectedSize();
  playSound("rotate");

  updateAll();
}

function clearFleet() {
  if (!canEditPlacement()) {
    return;
  }

  state.playerFleet = [];
  state.selectedSize = 4;
  state.horizontal = true;

  playSound("rotate");
  updateAll();
}

function createAndPlaceRandomFleet() {
  if (!canEditPlacement()) {
    return;
  }

  try {
    state.playerFleet =
      createRandomFleet();

    normalizeSelectedSize();

    playSound("place");

    updateAll();
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "Не удалось создать флот."
    );
  }
}

function rotatePlacement() {
  if (!canEditPlacement()) {
    return;
  }

  state.horizontal =
    !state.horizontal;

  playSound("rotate");

  updateAll();
}

function prepareLocalBattle() {
  let fleet;

  try {
    fleet = validateFleet(
      state.playerFleet
    );
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "Расстановка не завершена."
    );

    return;
  }

  state.playerFleet = fleet;

  try {
    state.enemyFleet =
      createRandomFleet();
  } catch {
    showToast(
      "Не удалось создать флот соперника."
    );
    return;
  }

  state.phase = "battle";
  state.turn =
    Math.random() < 0.5
      ? "player"
      : "opponent";

  state.winner = null;
  state.resultReason = null;

  addLog("Бой начался!");

  platform.gameplayStart();
  playSound("button");

  updateAll();

  if (
    state.turn === "opponent"
  ) {
    scheduleBotTurn(650);
  }
}

function prepareOnlineBattle() {
  const fleet = clone(
    state.playerFleet
  );

  state.actionLocked = true;
  state.submittedFleet = true;

  const sent =
    onlineClient.sendAction(
      "place",
      { fleet }
    );

  if (!sent) {
    state.actionLocked = false;
    state.submittedFleet = false;

    showToast(
      "Нет соединения с сервером."
    );

    updateAll();
    return;
  }

  addLog(
    "Флот отправлен. Ожидаем соперника."
  );

  updateAll();
}

function onReadyButton() {
  if (
    state.phase !== "placing" ||
    (
      state.mode === "online" &&
      state.submittedFleet
    )
  ) {
    return;
  }

  unlockAudio();

  if (
    state.mode === "online"
  ) {
    prepareOnlineBattle();
  } else {
    prepareLocalBattle();
  }
}

function getAttackCoordinate(
  x,
  y
) {
  return `${x + 1}:${y + 1}`;
}

function finishLocalGame(winner) {
  if (
    state.phase === "finished"
  ) {
    return;
  }

  state.phase = "finished";
  state.turn = null;
  state.winner = winner;

  state.resultReason =
    winner === "player"
      ? "Все корабли соперника уничтожены."
      : "Ваш флот уничтожен первым.";

  state.actionLocked = false;

  platform.gameplayStop();

  addLog(
    winner === "player"
      ? "Победа! Соперник потерял весь флот."
      : "Поражение. Соперник уничтожил весь флот."
  );

  playSound(
    winner === "player"
      ? "win"
      : "lose"
  );

  updateAll();
}

function fireLocalAt(x, y) {
  if (
    state.mode !== "bot" ||
    state.phase !== "battle" ||
    state.turn !== "player" ||
    state.actionLocked ||
    !state.enemyFleet
  ) {
    return;
  }

  state.actionLocked = true;

  let result;

  try {
    result = applyAttack(
      state.enemyFleet,
      state.playerAttacks,
      x,
      y
    );
  } catch (error) {
    state.actionLocked = false;

    showToast(
      error instanceof Error
        ? error.message
        : "Нельзя стрелять в эту клетку."
    );

    return;
  }

  const coordinate =
    getAttackCoordinate(
      result.x,
      result.y
    );

  if (result.result === "hit") {
    if (result.sunk) {
      addLog(
        `${coordinate}: попадание, корабль уничтожен!`
      );
    } else {
      addLog(
        `${coordinate}: попадание.`
      );
    }

    playSound("hit");
  } else {
    addLog(
      `${coordinate}: мимо.`
    );

    playSound("miss");
  }

  if (
    isFleetDestroyed(
      state.enemyFleet,
      state.playerAttacks
    )
  ) {
    state.actionLocked = false;
    finishLocalGame("player");
    return;
  }

  state.turn = "opponent";
  state.actionLocked = false;

  updateAll();

  scheduleBotTurn(680);
}

function fireOnlineAt(x, y) {
  if (
    state.mode !== "online" ||
    state.phase !== "battle" ||
    state.turn !== "player" ||
    state.actionLocked
  ) {
    return;
  }

  if (
    !state.opponentConnected
  ) {
    showToast(
      "Соперник временно отключён."
    );
    return;
  }

  const sent =
    onlineClient.sendAction(
      "fire",
      { x, y }
    );

  if (!sent) {
    showToast(
      "Нет соединения с сервером."
    );
    return;
  }

  state.actionLocked = true;

  elements.statusText.textContent =
    "Отправляем выстрел на сервер…";

  requestRender(700);
}

function fireAt(x, y) {
  if (
    state.phase !== "battle" ||
    state.turn !== "player" ||
    state.actionLocked
  ) {
    return;
  }

  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= BOARD_SIZE ||
    y >= BOARD_SIZE
  ) {
    return;
  }

  if (
    state.mode === "online"
  ) {
    fireOnlineAt(x, y);
  } else {
    fireLocalAt(x, y);
  }
}

function scheduleBotTurn(delay = 650) {
  clearTimeout(botTimer);

  const currentEpoch =
    botEpoch;

  botTimer = setTimeout(
    () => runBotTurn(currentEpoch),
    delay
  );
}

function runBotTurn(currentEpoch) {
  if (
    currentEpoch !== botEpoch ||
    state.mode !== "bot" ||
    state.phase !== "battle" ||
    state.turn !== "opponent" ||
    !state.playerFleet
  ) {
    return;
  }

  const target =
    chooseBotTarget(
      state.enemyAttacks
    );

  if (!target) {
    return;
  }

  let result;

  try {
    result = applyAttack(
      state.playerFleet,
      state.enemyAttacks,
      target.x,
      target.y
    );
  } catch {
    state.turn = "player";
    updateAll();
    return;
  }

  const coordinate =
    getAttackCoordinate(
      result.x,
      result.y
    );

  if (result.result === "hit") {
    if (result.sunk) {
      addLog(
        `Компьютер: ${coordinate}, попадание. Корабль уничтожен!`
      );
    } else {
      addLog(
        `Компьютер: ${coordinate}, попадание.`
      );
    }

    playSound("hit");
  } else {
    addLog(
      `Компьютер: ${coordinate}, мимо.`
    );

    playSound("miss");
  }

  if (
    isFleetDestroyed(
      state.playerFleet,
      state.enemyAttacks
    )
  ) {
    finishLocalGame("opponent");
    return;
  }

  state.turn = "player";

  updateAll();
}

function copyFleetFromMessage(message) {
  return clone(
    message?.self?.fleet ||
      []
  );
}

function applyOnlineState(message) {
  const previousPhase =
    state.phase;

  const isNewRoom =
    state.mode !== "online" ||
    state.roomCode !== message.code;

  botEpoch += 1;
  clearTimeout(botTimer);

  state.mode = "online";
  state.roomCode = message.code;
  state.round = message.round || 1;

  state.phase = message.phase;
  state.turn =
    message.turn === "self"
      ? "player"
      : message.turn === "opponent"
        ? "opponent"
        : null;

  state.winner =
    message.winner === "self"
      ? "player"
      : message.winner === "opponent"
        ? "opponent"
        : null;

  state.resultReason =
    message.resultReason || null;

  // Сервер присылает boards.self.attacks — это выстрелы ПО своей доске
  // (сделанные соперником), а boards.opponent.attacks — выстрелы, сделанные мной.
  state.playerAttacks = clone(
    message.boards?.opponent?.attacks ||
      []
  );

  state.enemyAttacks = clone(
    message.boards?.self?.attacks ||
      []
  );

  state.enemyFleet = null;

  state.opponentConnected =
    message.opponent?.connected !== false;

  state.disconnectDeadline =
    message.disconnectDeadline || null;

  state.rematchSelf =
    Boolean(message.rematch?.self);

  state.rematchOpponent =
    Boolean(
      message.rematch?.opponent
    );

  state.logs = Array.isArray(
    message.events
  )
    ? message.events.map(
        (event) => event.text
      )
    : [];

  state.submittedFleet =
    Boolean(message.self?.ready);

  state.actionLocked = false;

  if (
    Array.isArray(message.self?.fleet)
  ) {
    state.playerFleet = clone(
      message.self.fleet
    );

    normalizeSelectedSize();
  } else if (isNewRoom) {
    state.playerFleet = [];
    state.selectedSize = 4;
  }

  state.hover.player = null;
  state.hover.enemy = null;

  revealGameScreen();

  elements.roomBadge.hidden = false;
  elements.roomBadge.textContent =
    `КОМНАТА ${message.code}`;

  if (
    state.phase === "finished"
  ) {
    platform.gameplayStop();
  } else {
    platform.gameplayStart();
  }

  if (
    state.phase === "battle"
  ) {
    state.activeMobileBoard =
      state.turn === "player"
        ? "enemy"
        : "player";
  } else if (
    state.phase === "placing"
  ) {
    state.activeMobileBoard =
      "player";
  }

  if (
    previousPhase !== "finished" &&
    state.phase === "finished"
  ) {
    playSound(
      state.winner === "player"
        ? "win"
        : "lose"
    );
  }

  setOnlineStatus(
    "Соединение установлено.",
    "connected"
  );

  updateAll();
}

function getCellFromPointer(
  canvas,
  pointerEvent
) {
  const rectangle =
    canvas.getBoundingClientRect();

  if (
    rectangle.width <= 0 ||
    rectangle.height <= 0
  ) {
    return null;
  }

  const canvasX =
    (
      (pointerEvent.clientX -
        rectangle.left) /
      rectangle.width
    ) *
    canvas.width;

  const canvasY =
    (
      (pointerEvent.clientY -
        rectangle.top) /
      rectangle.height
    ) *
    canvas.height;

  const boardX =
    canvasX - BOARD_PADDING;

  const boardY =
    canvasY - BOARD_PADDING;

  if (
    boardX < 0 ||
    boardY < 0 ||
    boardX >= BOARD_RENDER_SIZE ||
    boardY >= BOARD_RENDER_SIZE
  ) {
    return null;
  }

  return {
    x: Math.floor(boardX / CELL_SIZE),
    y: Math.floor(boardY / CELL_SIZE)
  };
}

function getCellFromKeyboard(
  role,
  key
) {
  const deltas = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1]
  };

  const delta =
    deltas[key];

  if (!delta) {
    return null;
  }

  const current =
    state.hover[role] || {
      x: 4,
      y: 4
    };

  return {
    x: Math.max(
      0,
      Math.min(
        BOARD_SIZE - 1,
        current.x + delta[0]
      )
    ),
    y: Math.max(
      0,
      Math.min(
        BOARD_SIZE - 1,
        current.y + delta[1]
      )
    )
  };
}

function onBoardPointerMove(
  role,
  event
) {
  const canvas =
    role === "player"
      ? elements.playerCanvas
      : elements.enemyCanvas;

  const cell =
    getCellFromPointer(
      canvas,
      event
    );

  state.hover[role] = cell;

  requestRender();
}

function onBoardPointerLeave(
  role
) {
  state.hover[role] = null;

  requestRender();
}

function onBoardPointerDown(
  role,
  event
) {
  if (
    event.pointerType === "mouse" &&
    event.button !== 0
  ) {
    return;
  }

  event.preventDefault();

  void unlockAudio();

  const canvas =
    role === "player"
      ? elements.playerCanvas
      : elements.enemyCanvas;

  const cell =
    getCellFromPointer(
      canvas,
      event
    );

  if (!cell) {
    return;
  }

  state.hover[role] = cell;

  if (role === "player") {
    if (canEditPlacement()) {
      placeAt(cell.x, cell.y);
    }

    return;
  }

  fireAt(cell.x, cell.y);
}

function onBoardKeyDown(
  role,
  event
) {
  const arrowCell =
    getCellFromKeyboard(
      role,
      event.key
    );

  if (arrowCell) {
    event.preventDefault();

    state.hover[role] =
      arrowCell;

    requestRender();
    return;
  }

  if (
    event.key !== "Enter" &&
    event.key !== " "
  ) {
    return;
  }

  event.preventDefault();

  const cell =
    state.hover[role] || {
      x: 4,
      y: 4
    };

  state.hover[role] = cell;

  if (role === "player") {
    if (canEditPlacement()) {
      placeAt(cell.x, cell.y);
    }
  } else {
    fireAt(cell.x, cell.y);
  }
}

function roundedRectanglePath(
  context,
  x,
  y,
  width,
  height,
  radius
) {
  const safeRadius =
    Math.min(
      radius,
      width / 2,
      height / 2
    );

  context.beginPath();

  context.moveTo(
    x + safeRadius,
    y
  );

  context.lineTo(
    x + width - safeRadius,
    y
  );

  context.quadraticCurveTo(
    x + width,
    y,
    x + width,
    y + safeRadius
  );

  context.lineTo(
    x + width,
    y + height - safeRadius
  );

  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - safeRadius,
    y + height
  );

  context.lineTo(
    x + safeRadius,
    y + height
  );

  context.quadraticCurveTo(
    x,
    y + height,
    x,
    y + height - safeRadius
  );

  context.lineTo(
    x,
    y + safeRadius
  );

  context.quadraticCurveTo(
    x,
    y,
    x + safeRadius,
    y
  );

  context.closePath();
}

function drawShip(
  context,
  ship,
  attackedCells
) {
  const xs =
    ship.cells.map(
      (cell) => cell.x
    );

  const ys =
    ship.cells.map(
      (cell) => cell.y
    );

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const horizontal =
    minY === maxY;

  const shipLength =
    horizontal
      ? (maxX - minX + 1) *
        CELL_SIZE
      : (maxY - minY + 1) *
        CELL_SIZE;

  const centerBoardX =
    BOARD_PADDING +
    (minX + maxX + 1) *
      (CELL_SIZE / 2);

  const centerBoardY =
    BOARD_PADDING +
    (minY + maxY + 1) *
      (CELL_SIZE / 2);

  const width =
    horizontal
      ? shipLength - 7
      : CELL_SIZE - 7;

  const height =
    horizontal
      ? CELL_SIZE - 7
      : shipLength - 7;

  const isSunk =
    ship.cells.every(
      (cell) =>
        attackedCells.has(
          `${cell.x}:${cell.y}`
        )
    );

  context.save();

  context.translate(
    centerBoardX,
    centerBoardY
  );

  if (!horizontal) {
    context.rotate(
      Math.PI / 2
    );
  }

  context.shadowColor =
    "rgba(0, 0, 0, 0.4)";

  context.shadowBlur = 10;
  context.shadowOffsetY = 5;

  roundedRectanglePath(
    context,
    -width / 2,
    -height / 2,
    width,
    height,
    12
  );

  const shipGradient =
    context.createLinearGradient(
      -width / 2,
      -height / 2,
      width / 2,
      height / 2
    );

  if (isSunk) {
    shipGradient.addColorStop(
      0,
      "#536875"
    );

    shipGradient.addColorStop(
      1,
      "#293c48"
    );
  } else {
    shipGradient.addColorStop(
      0,
      "#a4d1ad"
    );

    shipGradient.addColorStop(
      0.55,
      "#6fa784"
    );

    shipGradient.addColorStop(
      1,
      "#3f6955"
    );
  }

  context.fillStyle =
    shipGradient;

  context.fill();

  context.shadowColor =
    "transparent";

  context.lineWidth = 3;
  context.strokeStyle =
    "rgba(218, 255, 227, 0.3)";

  context.stroke();

  roundedRectanglePath(
    context,
    -width / 2 + 7,
    -height / 2 + 7,
    Math.max(4, width - 14),
    Math.max(4, height - 14),
    7
  );

  context.fillStyle =
    "rgba(31, 75, 55, 0.28)";

  context.fill();

  context.beginPath();
  context.arc(
    0,
    0,
    Math.min(
      width,
      height
    ) * 0.16,
    0,
    Math.PI * 2
  );

  context.fillStyle =
    "#d0e8d7";

  context.fill();

  context.strokeStyle =
    "#476d59";

  context.lineWidth = 3;

  context.beginPath();
  context.moveTo(
    -Math.min(width, height) * 0.13,
    0
  );
  context.lineTo(
    Math.min(width, height) * 0.13,
    0
  );

  context.stroke();

  context.restore();
}

function drawAttack(
  context,
  attack
) {
  const centerX =
    BOARD_PADDING +
    attack.x * CELL_SIZE +
    CELL_SIZE / 2;

  const centerY =
    BOARD_PADDING +
    attack.y * CELL_SIZE +
    CELL_SIZE / 2;

  const radius =
    CELL_SIZE * 0.25;

  if (attack.result === "hit") {
    const age =
      Date.now() -
      Number(attack.at || 0);

    if (age < 900) {
      context.beginPath();
      context.arc(
        centerX,
        centerY,
        radius +
          (age / 900) *
            CELL_SIZE *
            0.12,
        0,
        Math.PI * 2
      );

      context.strokeStyle =
        `rgba(255, 128, 93, ${
          Math.max(
            0,
            0.7 - age / 1200
          )
        })`;

      context.lineWidth = 6;

      context.stroke();
    }

    const gradient =
      context.createRadialGradient(
        centerX - 8,
        centerY - 8,
        2,
        centerX,
        centerY,
        radius
      );

    gradient.addColorStop(
      0,
      "#ffe1a0"
    );

    gradient.addColorStop(
      0.35,
      "#ff9c54"
    );

    gradient.addColorStop(
      1,
      "#be3d33"
    );

    context.beginPath();
    context.arc(
      centerX,
      centerY,
      radius,
      0,
      Math.PI * 2
    );

    context.fillStyle = gradient;
    context.fill();

    context.strokeStyle =
      "#6f2925";

    context.lineWidth = 4;

    context.stroke();

    context.beginPath();

    for (
      let index = 0;
      index < 8;
      index += 1
    ) {
      const angle =
        (Math.PI * 2 * index) /
          8 +
        Math.PI / 8;

      const innerX =
        centerX +
        Math.cos(angle) *
          radius *
          0.22;

      const innerY =
        centerY +
        Math.sin(angle) *
          radius *
          0.22;

      const outerX =
        centerX +
        Math.cos(angle) *
          radius *
          0.9;

      const outerY =
        centerY +
        Math.sin(angle) *
          radius *
          0.9;

      if (index === 0) {
        context.moveTo(
          innerX,
          innerY
        );
      } else {
        context.lineTo(
          innerX,
          innerY
        );
      }

      context.lineTo(
        outerX,
        outerY
      );
    }

    context.strokeStyle =
      "rgba(92, 33, 28, 0.78)";

    context.lineWidth = 4;

    context.stroke();

    return;
  }

  context.beginPath();
  context.arc(
    centerX,
    centerY,
    radius * 0.82,
    0,
    Math.PI * 2
  );

  context.fillStyle =
    "rgba(8, 26, 40, 0.64)";

  context.fill();

  context.strokeStyle =
    "rgba(171, 193, 205, 0.8)";

  context.lineWidth = 5;

  context.beginPath();
  context.moveTo(
    centerX - radius * 0.55,
    centerY - radius * 0.55
  );
  context.lineTo(
    centerX + radius * 0.55,
    centerY + radius * 0.55
  );
  context.moveTo(
    centerX + radius * 0.55,
    centerY - radius * 0.55
  );
  context.lineTo(
    centerX - radius * 0.55,
    centerY + radius * 0.55
  );

  context.stroke();
}

function drawPlacementPreview(
  context,
  role
) {
  const hover =
    state.hover[role];

  if (!hover) {
    return;
  }

  let cells = null;
  let valid = false;

  if (
    role === "player" &&
    canEditPlacement()
  ) {
    cells =
      getCandidateCells(
        hover.x,
        hover.y
      );

    valid =
      candidateFits(cells) &&
      canPlaceShip(
        cells,
        state.playerFleet
      );
  }

  if (
    role === "enemy" &&
    state.phase === "battle" &&
    state.turn === "player" &&
    !state.actionLocked
  ) {
    cells = [hover];
    valid = true;
  }

  if (!cells) {
    return;
  }

  for (const cell of cells) {
    if (
      cell.x < 0 ||
      cell.y < 0 ||
      cell.x >= BOARD_SIZE ||
      cell.y >= BOARD_SIZE
    ) {
      continue;
    }

    const x =
      BOARD_PADDING +
      cell.x * CELL_SIZE;

    const y =
      BOARD_PADDING +
      cell.y * CELL_SIZE;

    context.fillStyle = valid
      ? "rgba(79, 232, 191, 0.34)"
      : "rgba(255, 85, 106, 0.34)";

    context.fillRect(
      x + 3,
      y + 3,
      CELL_SIZE - 6,
      CELL_SIZE - 6
    );

    context.strokeStyle = valid
      ? "rgba(126, 255, 220, 0.9)"
      : "rgba(255, 130, 146, 0.9)";

    context.lineWidth = 4;

    context.strokeRect(
      x + 5,
      y + 5,
      CELL_SIZE - 10,
      CELL_SIZE - 10
    );
  }
}

function drawBoard(
  canvas,
  role
) {
  const context =
    canvas.getContext("2d");

  if (!context) {
    return;
  }

  context.clearRect(
    0,
    0,
    canvas.width,
    canvas.height
  );

  const oceanGradient =
    context.createLinearGradient(
      0,
      0,
      CANVAS_SIZE,
      CANVAS_SIZE
    );

  oceanGradient.addColorStop(
    0,
    "#0a2941"
  );

  oceanGradient.addColorStop(
    0.5,
    "#0c3550"
  );

  oceanGradient.addColorStop(
    1,
    "#081f32"
  );

  context.fillStyle =
    oceanGradient;

  context.fillRect(
    0,
    0,
    canvas.width,
    canvas.height
  );

  const boardX =
    BOARD_PADDING;

  const boardY =
    BOARD_PADDING;

  context.fillStyle =
    "rgba(25, 88, 116, 0.26)";

  context.fillRect(
    boardX,
    boardY,
    BOARD_RENDER_SIZE,
    BOARD_RENDER_SIZE
  );

  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const pixelX =
        boardX + x * CELL_SIZE;

      const pixelY =
        boardY + y * CELL_SIZE;

      context.fillStyle =
        (x + y) % 2 === 0
          ? "rgba(35, 110, 138, 0.14)"
          : "rgba(7, 39, 58, 0.13)";

      context.fillRect(
        pixelX,
        pixelY,
        CELL_SIZE,
        CELL_SIZE
      );

      context.strokeStyle =
        "rgba(139, 207, 231, 0.28)";

      context.lineWidth = 2;

      context.beginPath();

      context.moveTo(
        pixelX,
        pixelY
      );

      context.lineTo(
        pixelX,
        pixelY + CELL_SIZE
      );

      context.moveTo(
        pixelX,
        pixelY
      );

      context.lineTo(
        pixelX + CELL_SIZE,
        pixelY
      );

      context.stroke();

      context.strokeStyle =
        "rgba(222, 248, 255, 0.14)";

      context.lineWidth = 1;

      context.strokeRect(
        pixelX + 1,
        pixelY + 1,
        CELL_SIZE - 2,
        CELL_SIZE - 2
      );
    }
  }

  context.strokeStyle =
    "rgba(150, 220, 241, 0.65)";

  context.lineWidth = 4;

  context.strokeRect(
    boardX,
    boardY,
    BOARD_RENDER_SIZE,
    BOARD_RENDER_SIZE
  );

  context.fillStyle =
    "rgba(199, 228, 240, 0.82)";

  context.font =
    "700 22px system-ui, sans-serif";

  context.textAlign = "center";
  context.textBaseline = "middle";

  for (let index = 0; index < BOARD_SIZE; index += 1) {
    context.fillText(
      String(index + 1),
      boardX +
        index * CELL_SIZE +
        CELL_SIZE / 2,
      boardY - 21
    );

    context.fillText(
      String(index + 1),
      boardX - 23,
      boardY +
        index * CELL_SIZE +
        CELL_SIZE / 2
    );
  }

  const fleet =
    role === "player"
      ? state.playerFleet
      : state.enemyFleet;

  const attacks =
    role === "player"
      ? state.enemyAttacks
      : state.playerAttacks;

  const attackedCells =
    new Set(
      attacks.map(
        (attack) =>
          `${attack.x}:${attack.y}`
      )
    );

  for (const ship of fleet || []) {
    drawShip(
      context,
      ship,
      attackedCells
    );
  }

  for (const attack of attacks) {
    drawAttack(
      context,
      attack
    );
  }

  drawPlacementPreview(
    context,
    role
  );
}

function requestRender(animationMs = 0) {
  animateRenderUntil =
    Math.max(
      animateRenderUntil,
      performance.now() + animationMs
    );

  if (animationFrame !== null) {
    return;
  }

  const render = () => {
    animationFrame = null;

    drawBoard(
      elements.playerCanvas,
      "player"
    );

    drawBoard(
      elements.enemyCanvas,
      "enemy"
    );

    if (
      performance.now() <
      animateRenderUntil
    ) {
      animationFrame =
        requestAnimationFrame(
          render
        );
    }
  };

  animationFrame =
    requestAnimationFrame(render);
}

function renderFleetTray() {
  normalizeSelectedSize();

  const counts =
    getFleetCounts();

  elements.fleetTray.replaceChildren();

  for (
    const definition
    of FLEET_LAYOUT
  ) {
    const button =
      document.createElement("button");

    button.type = "button";

    const remaining =
      counts.get(
        definition.size
      ) || 0;

    const placed =
      definition.count -
      remaining;

    button.className =
      "fleet-chip";

    if (
      state.selectedSize ===
      definition.size
    ) {
      button.classList.add(
        "selected"
      );
    }

    button.disabled =
      !canEditPlacement() ||
      remaining === 0;

    button.setAttribute(
      "aria-pressed",
      String(
        state.selectedSize ===
        definition.size
      )
    );

    button.innerHTML = `
      ${definition.size} × 1
      <small>
        ${placed} / ${definition.count}
      </small>
    `;

    button.addEventListener(
      "click",
      () => {
        if (!canEditPlacement()) {
          return;
        }

        state.selectedSize =
          definition.size;

        playSound("button");

        updateAll();
      }
    );

    elements.fleetTray.appendChild(
      button
    );
  }
}

function renderStatus() {
  let text = "";
  let tone = "neutral";

  if (
    state.phase === "placing"
  ) {
    if (
      state.mode === "online"
    ) {
      if (state.submittedFleet) {
        text =
          "Ваш флот принят. Ожидаем готовности соперника.";
      } else {
        text =
          "Расставьте корабли, затем нажмите «Я готов».";
      }
    } else {
      text =
        "Расставьте все корабли и нажмите «Я готов».";
    }
  } else if (
    state.phase === "battle"
  ) {
    if (
      state.turn === "player"
    ) {
      tone = "player";

      text =
        state.mode === "online"
          ? "Ваш ход. Выберите клетку на поле соперника."
          : "Ваш ход. Выберите клетку поля компьютера.";
    } else {
      tone = "opponent";

      text =
        state.mode === "online"
          ? "Ход соперника…"
          : "Компьютер выбирает клетку…";
    }
  } else {
    tone = "finished";

    text =
      state.winner === "player"
        ? "Бой окончен. Победа!"
        : "Бой окончен. Поражение.";
  }

  elements.statusText.textContent =
    text;

  elements.statusBanner.dataset.tone =
    tone;

  elements.disconnectText.textContent =
    "";

  if (
    state.mode === "online" &&
    !state.opponentConnected &&
    state.disconnectDeadline
  ) {
    const seconds = Math.max(
      0,
      Math.ceil(
        (state.disconnectDeadline -
          Date.now()) /
          1000
      )
    );

    elements.disconnectText.textContent =
      `Соперник отключён. Возвращение в игру через ${seconds} с.`;
  }
}

function renderPlacementPanel() {
  const isPlacement =
    state.phase === "placing";

  elements.placementPanel.hidden =
    !isPlacement;

  if (!isPlacement) {
    return;
  }

  normalizeSelectedSize();

  let fleetIsValid = false;

  try {
    validateFleet(
      state.playerFleet
    );

    fleetIsValid = true;
  } catch {
    fleetIsValid = false;
  }

  const canEdit =
    canEditPlacement();

  elements.rotateButton.disabled =
    !canEdit;

  elements.randomFleetButton.disabled =
    !canEdit;

  elements.clearFleetButton.disabled =
    !canEdit;

  elements.readyButton.disabled =
    !fleetIsValid ||
    !canEdit;

  elements.readyButton.textContent =
    state.mode === "online"
      ? state.submittedFleet
        ? "Ожидаем соперника"
        : "Перейти в бой"
      : "Я готов";

  if (
    state.submittedFleet
  ) {
    elements.placementHint.textContent =
      "Сервер принял флот. Изменить расстановку уже нельзя.";

    elements.placementBadge.textContent =
      "Ожидание соперника";
  } else if (fleetIsValid) {
    elements.placementHint.textContent =
      "Флот готов к бою.";

    elements.placementBadge.textContent =
      "Все корабли размещены";
  } else {
    const remaining =
      FLEET_LAYOUT.reduce(
        (total, definition) =>
          total +
          (
            getFleetCounts().get(
              definition.size
            ) || 0
          ),
        0
      );

    elements.placementHint.textContent =
      `Осталось разместить кораблей: ${remaining}.`;

    elements.placementBadge.textContent =
      "Расстановка";
  }
}

function renderBoards() {
  const isOnline =
    state.mode === "online";

  elements.modeBadge.textContent =
    isOnline
      ? "ОНЛАЙН"
      : "КОМПЬЮТЕР";

  elements.roomBadge.hidden =
    !isOnline ||
    !state.roomCode;

  elements.roomBadge.textContent =
    state.roomCode
      ? `КОМНАТА ${state.roomCode}`
      : "";

  elements.playerTitle.textContent =
    "Ваш флот";

  elements.enemyTitle.textContent =
    isOnline
      ? "Соперник"
      : "Компьютер";

  if (
    state.phase === "placing"
  ) {
    elements.playerSubtitle.textContent =
      isOnline
        ? "Ваше игровое поле"
        : "Расставьте все корабли";

    elements.enemySubtitle.textContent =
      isOnline
        ? state.opponentConnected
          ? "Поле скрытого флота соперника"
          : "Соперник отключён"
        : "Флот компьютера скрыт";
  } else if (
    state.phase === "battle"
  ) {
    elements.playerSubtitle.textContent =
      "Здесь находятся ваши корабли";

    elements.enemySubtitle.textContent =
      state.turn === "player"
        ? "Выберите клетку для выстрела"
        : "Ожидайте выстрел соперника";
  } else {
    elements.playerSubtitle.textContent =
      "Бой завершён";

    elements.enemySubtitle.textContent =
      "Бой завершён";
  }

  elements.playerCanvas.style.cursor =
    canEditPlacement()
      ? "crosshair"
      : "default";

  elements.enemyCanvas.style.cursor =
    state.phase === "battle" &&
    state.turn === "player" &&
    !state.actionLocked
      ? "crosshair"
      : "default";

  elements.playerCanvas.setAttribute(
    "aria-label",
    state.phase === "placing"
      ? "Ваше поле. Выберите клетку для размещения корабля."
      : "Ваше поле с кораблями и выстрелами соперника."
  );

  elements.enemyCanvas.setAttribute(
    "aria-label",
    "Поле соперника. Выберите клетку для выстрела."
  );

  state.activeMobileBoard =
    state.phase === "placing"
      ? "player"
      : state.turn === "player"
        ? "enemy"
        : "player";

  if (mobileMedia.matches) {
    elements.playerPane.classList.toggle(
      "mobile-active",
      state.activeMobileBoard ===
        "player"
    );

    elements.enemyPane.classList.toggle(
      "mobile-active",
      state.activeMobileBoard ===
        "enemy"
    );

    for (
      const button
      of elements.mobileBoardTabs.querySelectorAll(
        "button"
      )
    ) {
      const selected =
        button.dataset.board ===
        state.activeMobileBoard;

      button.setAttribute(
        "aria-selected",
        String(selected)
      );
    }
  }
}

function renderEventLog() {
  const entries =
    state.logs.length > 0
      ? [...state.logs].reverse()
      : ["Ожидание событий…"];

  const fragment =
    document.createDocumentFragment();

  for (const entry of entries) {
    const item =
      document.createElement("li");

    item.textContent =
      entry;

    fragment.appendChild(
      item
    );
  }

  elements.eventLog.replaceChildren(
    fragment
  );

  elements.eventLog.scrollTop = 0;

  if (
    state.phase === "placing"
  ) {
    elements.tipText.textContent =
      state.mode === "online"
        ? "Для онлайн-игры сервер проверяет флот и каждый выстрел. Положение кораблей соперника клиенту не передаётся."
        : "Нажмите на уже размещённый корабль, чтобы убрать его. Кнопка «Случайно» создаст допустимую расстановку.";
  } else if (
    state.turn === "player"
  ) {
    elements.tipText.textContent =
      "После попадания обычно стоит проверить соседние клетки. Координаты скрытого флота соперника отображаются только рядом с его выстрелами.";
  } else {
    elements.tipText.textContent =
      "Дождитесь хода соперника. Ваши попадания отмечаются на его поле, а его выстрелы — на вашем.";
  }
}

function renderResult() {
  if (
    state.phase !== "finished"
  ) {
    elements.resultOverlay.hidden =
      true;

    return;
  }

  const resultKey = [
    state.mode,
    state.roomCode,
    state.round,
    state.winner
  ].join(":");

  const isNewResult =
    resultKey !== state.resultKey;

  state.resultKey = resultKey;

  const won =
    state.winner === "player";

  elements.resultTitle.textContent =
    won
      ? "Победа!"
      : "Поражение";

  let description =
    state.resultReason ||
    (
      won
        ? "Соперник потерял все корабли."
        : "Ваш флот уничтожен первым."
    );

  if (
    state.mode === "online" &&
    !state.opponentConnected
  ) {
    description =
      "Соперник отключился и не вернулся в комнату.";
  }

  elements.resultText.textContent =
    description;

  if (
    state.mode === "online"
  ) {
    elements.resultPrimaryButton.textContent =
      state.rematchSelf
        ? "Ожидаем соперника"
        : state.opponentConnected
          ? "Сыграть реванш"
          : "Соперник покинул игру";

    elements.resultPrimaryButton.disabled =
      state.rematchSelf ||
      !state.opponentConnected;
  } else {
    elements.resultPrimaryButton.textContent =
      "Новый бой";

    elements.resultPrimaryButton.disabled =
      false;
  }

  elements.resultOverlay.hidden =
    false;

  if (isNewResult) {
    requestAnimationFrame(() => {
      elements.resultPrimaryButton.focus({
        preventScroll: true
      });
    });
  }
}

function renderSoundButton() {
  elements.soundButtonText.textContent =
    soundEnabled
      ? "Звук"
      : "Без звука";

  elements.soundButton.setAttribute(
    "aria-label",
    soundEnabled
      ? "Выключить звук"
      : "Включить звук"
  );

  elements.soundButton.setAttribute(
    "aria-pressed",
    String(soundEnabled)
  );
}

function updateAll() {
  renderStatus();
  renderPlacementPanel();
  renderFleetTray();
  renderBoards();
  renderEventLog();
  renderResult();
  renderSoundButton();

  requestRender();
}

function selectMobileBoard(
  board
) {
  if (
    board !== "player" &&
    board !== "enemy"
  ) {
    return;
  }

  state.activeMobileBoard =
    board;

  state.hover[board] = null;

  elements.playerPane.classList.toggle(
    "mobile-active",
    board === "player"
  );

  elements.enemyPane.classList.toggle(
    "mobile-active",
    board === "enemy"
  );

  for (
    const button
    of elements.mobileBoardTabs.querySelectorAll(
      "button"
    )
  ) {
    const selected =
      button.dataset.board === board;

    button.setAttribute(
      "aria-selected",
      String(selected)
    );
  }

  requestRender();
}

async function toggleFullscreen() {
  const changed =
    await platform.toggleFullscreen();

  if (!changed) {
    showToast(
      "Полноэкранный режим недоступен в этом браузере."
    );
  }

  updateAll();
}

async function toggleSound() {
  soundEnabled =
    !soundEnabled;

  writeLocalBoolean(
    "seaBattleSound",
    soundEnabled
  );

  if (soundEnabled) {
    await unlockAudio();
    playSound("button");
  }

  updateAll();
}

async function maybeShowFullscreenAd() {
  if (
    roundsSinceAd <
      adEveryRounds
  ) {
    return;
  }

  const timeSinceLastAd =
    Date.now() - lastAdAt;

  if (
    timeSinceLastAd <
      3 * 60 * 1000
  ) {
    return;
  }

  lastAdAt = Date.now();

  platform.gameplayStop();

  await platform.showFullscreenAd();

  roundsSinceAd = 0;
}

function requestRematch() {
  if (
    state.mode !== "online" ||
    state.phase !== "finished"
  ) {
    return;
  }

  if (
    state.rematchSelf ||
    !state.opponentConnected
  ) {
    return;
  }

  const sent =
    onlineClient.sendAction(
      "rematch"
    );

  if (!sent) {
    showToast(
      "Нет соединения с сервером."
    );
    return;
  }

  state.rematchSelf = true;
  state.actionLocked = true;

  elements.resultPrimaryButton.disabled =
    true;

  elements.resultPrimaryButton.textContent =
    "Ожидаем соперника";

  updateAll();
}

function onResultPrimary() {
  void unlockAudio();

  if (
    state.mode === "online"
  ) {
    requestRematch();
    return;
  }

  if (
    roundsSinceAd >=
      adEveryRounds
  ) {
    void maybeShowFullscreenAd();
  }

  startBotGame();
}

function incrementRoundCounter() {
  roundsSinceAd += 1;
}

const originalFinishLocalGame =
  finishLocalGame;

finishLocalGame = function (
  winner
) {
  const previousPhase =
    state.phase;

  originalFinishLocalGame(
    winner
  );

  if (
    previousPhase !==
      "finished" &&
    state.phase === "finished"
  ) {
    incrementRoundCounter();
  }
};

elements.botModeButton.addEventListener(
  "click",
  () => {
    void unlockAudio();

    if (
      roundsSinceAd >=
        adEveryRounds
    ) {
      void maybeShowFullscreenAd();
    }

    startBotGame();
  }
);

elements.onlineModeButton.addEventListener(
  "click",
  () => {
    void unlockAudio();
    openOnlineLobby();
  }
);

elements.quickMatchButton.addEventListener(
  "click",
  () => {
    playSound("button");

    onlineClient.join(
      "quick"
    );

    setOnlineStatus(
      "Ищем подходящего соперника…",
      "connecting"
    );
  }
);

elements.createRoomButton.addEventListener(
  "click",
  () => {
    playSound("button");

    onlineClient.join(
      "create"
    );

    setOnlineStatus(
      "Создаём комнату…",
      "connecting"
    );
  }
);

elements.joinRoomForm.addEventListener(
  "submit",
  (event) => {
    event.preventDefault();

    const code =
      sanitizeRoomCode(
        elements.joinCodeInput.value
      );

    if (code.length !== 5) {
      showToast(
        "Код комнаты должен содержать 5 символов."
      );

      return;
    }

    playSound("button");

    onlineClient.join(
      "join",
      code
    );

    setOnlineStatus(
      "Подключаемся к комнате…",
      "connecting"
    );
  }
);

elements.joinCodeInput.addEventListener(
  "input",
  () => {
    elements.joinCodeInput.value =
      sanitizeRoomCode(
        elements.joinCodeInput.value
      );
  }
);

elements.copyRoomCodeButton.addEventListener(
  "click",
  () => {
    void copyRoomCode();
  }
);

elements.cancelRoomButton.addEventListener(
  "click",
  () => {
    onlineClient.leave();

    elements.roomBox.hidden =
      true;

    setOnlineStatus(
      "Комната отменена.",
      "connected"
    );
  }
);

elements.backFromOnlineButton.addEventListener(
  "click",
  () => {
    onlineClient.leave();

    elements.onlineLobby.hidden =
      true;

    setOnlineStatus(
      "Не подключено",
      "closed"
    );
  }
);

elements.exitButton.addEventListener(
  "click",
  () => {
    returnToMenu(true);
  }
);

elements.rotateButton.addEventListener(
  "click",
  () => {
    rotatePlacement();
  }
);

elements.randomFleetButton.addEventListener(
  "click",
  () => {
    createAndPlaceRandomFleet();
  }
);

elements.clearFleetButton.addEventListener(
  "click",
  () => {
    clearFleet();
  }
);

elements.readyButton.addEventListener(
  "click",
  () => {
    onReadyButton();
  }
);

elements.soundButton.addEventListener(
  "click",
  () => {
    void toggleSound();
  }
);

elements.fullscreenButton.addEventListener(
  "click",
  () => {
    void toggleFullscreen();
  }
);

elements.resultPrimaryButton.addEventListener(
  "click",
  () => {
    onResultPrimary();
  }
);

elements.resultSecondaryButton.addEventListener(
  "click",
  () => {
    returnToMenu(false);
  }
);

for (
  const button
  of elements.mobileBoardTabs.querySelectorAll(
    "button"
  )
) {
  button.addEventListener(
    "click",
    () => {
      playSound("button");

      selectMobileBoard(
        button.dataset.board
      );
    }
  );
}

elements.playerCanvas.addEventListener(
  "pointermove",
  (event) => {
    onBoardPointerMove(
      "player",
      event
    );
  }
);

elements.playerCanvas.addEventListener(
  "pointerleave",
  () => {
    onBoardPointerLeave("player");
  }
);

elements.playerCanvas.addEventListener(
  "pointerdown",
  (event) => {
    onBoardPointerDown(
      "player",
      event
    );
  }
);

elements.playerCanvas.addEventListener(
  "keydown",
  (event) => {
    onBoardKeyDown(
      "player",
      event
    );
  }
);

elements.enemyCanvas.addEventListener(
  "pointermove",
  (event) => {
    onBoardPointerMove(
      "enemy",
      event
    );
  }
);

elements.enemyCanvas.addEventListener(
  "pointerleave",
  () => {
    onBoardPointerLeave("enemy");
  }
);

elements.enemyCanvas.addEventListener(
  "pointerdown",
  (event) => {
    onBoardPointerDown(
      "enemy",
      event
    );
  }
);

elements.enemyCanvas.addEventListener(
  "keydown",
  (event) => {
    onBoardKeyDown(
      "enemy",
      event
    );
  }
);

function onResize() {
  requestRender();
}

window.addEventListener(
  "resize",
  onResize
);

mobileMedia.addEventListener(
  "change",
  () => {
    renderBoards();
    requestRender();
  }
);

document.addEventListener(
  "visibilitychange",
  () => {
    if (
      document.hidden
    ) {
      platform.gameplayStop();
      return;
    }

    const gameIsActive =
      !elements.gameScreen.hidden &&
      state.phase !== "finished";

    if (gameIsActive) {
      platform.gameplayStart();
    }
  }
);

document.addEventListener(
  "pointerdown",
  () => {
    void unlockAudio();
  },
  {
    once: true,
    passive: true
  }
);

setInterval(() => {
  if (
    state.mode === "online" &&
    !elements.gameScreen.hidden &&
    !state.opponentConnected &&
    state.disconnectDeadline
  ) {
    renderStatus();
    requestRender(400);
  }
}, 500);

if (
  !platform.canUseFullscreen()
) {
  elements.fullscreenButton.hidden =
    true;
}

updateLobbyControls();
updateAll();

elements.app.hidden = false;
elements.loadingScreen.hidden = true;

void platform
  .init()
  .then(() => {
    platform.ready();
  });