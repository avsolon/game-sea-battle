import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { WebSocket } from "ws";

const projectRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

export const randomHex = (length) =>
  Array.from(
    { length },
    () =>
      Math.floor(
        Math.random() * 16
      ).toString(16)
  ).join("");

export async function startServer() {
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
          stop: () => child.kill("SIGTERM")
        };
      }
    } catch {
      // Сервер ещё не поднялся.
    }

    await new Promise(
      (resolve) => setTimeout(resolve, 100)
    );
  }

  child.kill("SIGTERM");

  throw new Error(
    "Сервер не запустился за 10 секунд"
  );
}

export function createClient(url) {
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

  client.wait = (predicate, timeoutMs = 5000) =>
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

  client.since = (mark) =>
    client.received.slice(mark);

  client.mark = () => client.received.length;

  // Ждёт сообщение, пришедшее ПОСЛЕ отметки mark.
  // Нужно, чтобы не поймать устаревшее состояние,
  // которое пришло раньше.
  client.waitAfter = (
    mark,
    predicate,
    timeoutMs = 5000
  ) =>
    new Promise((resolve, reject) => {
      const inspect = () => {
        for (
          let index = mark;
          index < client.received.length;
          index += 1
        ) {
          const message =
            client.received[index];

          if (message && predicate(message)) {
            return message;
          }
        }

        return null;
      };

      const deadline =
        Date.now() + timeoutMs;

      const poll = setInterval(() => {
        const found = inspect();

        if (found) {
          clearInterval(poll);
          resolve(found);
          return;
        }

        if (Date.now() > deadline) {
          clearInterval(poll);

          reject(
            new Error(
              `Timeout after mark=${mark}. Received types: ` +
                JSON.stringify(
                  client.received.map(
                    (message) => message.type
                  )
                )
            )
          );
        }
      }, 15);
    });

  return client;
}
