import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { WebSocket } from "ws";

import {
  createRandomFleet
} from "../public/shared/rules.mjs";

const projectRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const randomHex = (length) =>
  Array.from(
    { length },
    () =>
      Math.floor(
        Math.random() * 16
      ).toString(16)
  ).join("");

function createClient(url) {
  const webSocket = new WebSocket(url);

  const client = {
    webSocket,
    received: [],
    waiters: []
  };

  webSocket.on("message", (rawData) => {
    const message = JSON.parse(
      rawData.toString()
    );

    client.received.push(message);

    client.waiters = client.waiters.filter(
      (waiter) => !waiter(message)
    );
  });

  client.open = new Promise(
    (resolve, reject) => {
      webSocket.on("open", resolve);
      webSocket.on("error", reject);
    }
  );

  client.send = (packet) =>
    webSocket.send(JSON.stringify(packet));

  client.wait = (
    predicate,
    timeoutMs = 5000
  ) =>
    new Promise((resolve, reject) => {
      const existing =
        client.received.find(predicate);

      if (existing) {
        resolve(existing);
        return;
      }

      const timer = setTimeout(() => {
        reject(
          new Error(
            "Timeout. Received types: " +
              JSON.stringify(
                client.received.map(
                  (message) => message.type
                )
              )
          )
        );
      }, timeoutMs);

      client.waiters.push((message) => {
        if (!predicate(message)) {
          return false;
        }

        clearTimeout(timer);
        resolve(message);
        return true;
      });
    });

  // Сообщения, пришедшие после отметки: для проверки,
  // что событие не произошло ДО того, как мы начали ждать.
  client.since = (mark) =>
    client.received.slice(mark);

  client.mark = () =>
    client.received.length;

  return client;
}

async function startServer() {
  const port =
    20000 + Math.floor(Math.random() * 20000);

  const child = spawn(
    process.execPath,
    ["server.mjs"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "development"
      },
      stdio: "ignore"
    }
  );

  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/healthz`
      );

      if (response.ok) {
        return {
          port,
          stop: () =>
            child.kill("SIGTERM")
        };
      }
    } catch {
      // Сервер ещё не поднялся.
    }

    await new Promise(
      (resolve) =>
        setTimeout(resolve, 100)
    );
  }

  child.kill("SIGTERM");

  throw new Error(
    "Сервер не запустился за 10 секунд"
  );
}

test(
  "После перезагрузки страницы игрок возвращается в бой, а соперник узнаёт об этом",
  async (t) => {
    const server = await startServer();

    t.after(() => {
      server.stop();
    });

    const url = `ws://127.0.0.1:${server.port}/ws`;

    const tokenA = randomHex(48);
    const tokenB = randomHex(48);

    const clientA = createClient(url);
    const clientB = createClient(url);

    await Promise.all([
      clientA.open,
      clientB.open
    ]);

    t.after(() => {
      clientA.webSocket.close();
      clientB.webSocket.close();
    });

    clientA.send({
      type: "hello",
      token: tokenA
    });

    clientB.send({
      type: "hello",
      token: tokenB
    });

    clientA.send({
      type: "join",
      action: "create"
    });

    const waiting = await clientA.wait(
      (message) => message.type === "waiting"
    );

    assert.equal(
      waiting.code.length,
      5,
      "код комнаты из 5 символов"
    );

    clientB.send({
      type: "join",
      action: "join",
      code: waiting.code
    });

    await clientB.wait(
      (message) =>
        message.type === "state" &&
        Boolean(message.opponent)
    );

    clientA.send({
      type: "place",
      fleet: createRandomFleet()
    });

    await clientA.wait(
      (message) =>
        message.type === "placementAccepted"
    );

    clientB.send({
      type: "place",
      fleet: createRandomFleet()
    });

    await clientB.wait(
      (message) =>
        message.type === "placementAccepted"
    );

    await clientA.wait(
      (message) =>
        message.type === "state" &&
        message.phase === "battle"
    );

    // Игрок B «перезагружает браузер»: соединение рвётся.
    const beforeDisconnect = clientA.mark();

    clientB.webSocket.close();

    await clientA.wait(
      (message) =>
        message.type === "state" &&
        message.opponent?.connected === false,
      4000
    );

    // Новое соединение с тем же токеном, как после перезагрузки страницы.
    const beforeReturn = clientA.mark();

    const clientB2 = createClient(url);

    await clientB2.open;

    t.after(() => {
      clientB2.webSocket.close();
    });

    clientB2.send({
      type: "hello",
      token: tokenB
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    clientB2.send({
      type: "join",
      action: "reconnect"
    });

    const restored = await clientB2.wait(
      (message) => message.type === "state"
    );

    assert.equal(
      restored.code,
      waiting.code,
      "вернувшийся игрок остался в своей комнате"
    );

    assert.equal(
      restored.phase,
      "battle",
      "фаза боя восстановлена после перезагрузки"
    );

    assert.equal(
      restored.self.fleet?.length,
      10,
      "корабли вернувшегося игрока не потеряны"
    );

    assert.equal(
      restored.opponent?.connected,
      true,
      "соперник на месте"
    );

    // Регрессия: раньше состояние уходило только вернувшемуся игроку,
    // и соперник навсегда оставался с opponent.connected === false —
    // клиент блокирует выстрел при !opponentConnected.
    const notified = clientA
      .since(beforeReturn)
      .find(
        (message) =>
          message.type === "state" &&
          message.opponent?.connected === true
      );

    assert.ok(
      notified,
      "соперник узнал, что игрок вернулся"
    );

    assert.ok(
      clientA.since(beforeDisconnect).length > 0,
      "соперник видел отключение игрока"
    );
  }
);