import test from "node:test";
import assert from "node:assert/strict";

import {
  createRandomFleet
} from "../public/shared/rules.mjs";

import {
  createClient,
  randomHex,
  startServer
} from "./helpers.mjs";

const isBattleState = (message) =>
  message.type === "state" &&
  message.phase === "battle";

// Пауза, чтобы не упереться в лимит частоты сообщений.
const pause = (ms = 140) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Готовит комнату с двумя игроками и расставленными флотами.
 * Первый ход разыгрывается случайно, поэтому возвращает
 * стрелка и защитника по фактическому состоянию.
 */
async function createBattle(t) {
  const server = await startServer();

  t.after(() => {
    server.stop();
  });

  const url = `ws://127.0.0.1:${server.port}/ws`;

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
    token: randomHex(48)
  });

  clientB.send({
    type: "hello",
    token: randomHex(48)
  });

  clientA.send({
    type: "join",
    action: "create"
  });

  const waiting = await clientA.wait(
    (message) => message.type === "waiting"
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

  const fleetA = createRandomFleet();
  const fleetB = createRandomFleet();

  clientA.send({
    type: "place",
    fleet: fleetA
  });

  await clientA.wait(
    (message) =>
      message.type === "placementAccepted"
  );

  clientB.send({
    type: "place",
    fleet: fleetB
  });

  await clientB.wait(
    (message) =>
      message.type === "placementAccepted"
  );

  const startState =
    await clientA.wait(
      isBattleState
    );

  const aMovesFirst =
    startState.turn === "self";

  return {
    // Кто сейчас стреляет и чей флот под обстрелом.
    shooter: aMovesFirst ? clientA : clientB,
    waiting: aMovesFirst ? clientB : clientA,
    targetFleet: aMovesFirst
      ? fleetB
      : fleetA,
    ownFleet: aMovesFirst ? fleetA : fleetB
  };
}

// Свободная клетка на поле 10x10 вне указанного флота.
function findEmptyCell(fleet) {
  const occupied = new Set(
    fleet.flatMap((ship) =>
      ship.cells.map(
        (cell) => `${cell.x}:${cell.y}`
      )
    )
  );

  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 10; x += 1) {
      if (!occupied.has(`${x}:${y}`)) {
        return { x, y };
      }
    }
  }

  throw new Error(
    "Не нашлось свободной клетки"
  );
}

test(
  "При попадании стрелок ходит снова, после промаха ход переходит",
  async (t) => {
    const { shooter, waiting, targetFleet } =
      await createBattle(t);

    // Первая палуба корабля соперника.
    const target = targetFleet[0].cells[0];

    await pause();

    const afterHitMark = shooter.mark();

    shooter.send({
      type: "fire",
      x: target.x,
      y: target.y
    });

    const afterHit =
      await shooter.waitAfter(
        afterHitMark,
        isBattleState
      );

    assert.equal(
      afterHit.turn,
      "self",
      "после попадания ход остаётся у стрелка"
    );

    // Теперь промах: клетка вне флота соперника.
    const empty = findEmptyCell(targetFleet);

    // Отметка ДО выстрела: состояние соперника придёт
    // одновременно с нашим.
    const beforeB =
      waiting.mark();

    await pause();

    const afterMissMark = shooter.mark();

    shooter.send({
      type: "fire",
      x: empty.x,
      y: empty.y
    });

    const afterMiss =
      await shooter.waitAfter(
        afterMissMark,
        isBattleState
      );

    assert.equal(
      afterMiss.turn,
      "opponent",
      "после промаха ход переходит сопернику"
    );

    // Соперник получает право выстрела.
    const bTurn =
      await waiting.waitAfter(
        beforeB,
        isBattleState
      );

    assert.equal(
      bTurn.turn,
      "self",
      "соперник получил ход после промаха"
    );

    const missTexts = (
      afterMiss.events || []
    ).map((event) => event.text);

    assert.ok(
      missTexts.some((text) =>
        text.includes("Мимо")
      ),
      "в журнале есть сообщение о промахе"
    );

    assert.ok(
      missTexts.some((text) =>
        text.includes("Попал - ранил")
      ),
      "в журнале есть сообщение о ранении"
    );
  }
);

test(
  "Сообщения различают ранение и потопление корабля",
  async (t) => {
    const { shooter, targetFleet } =
      await createBattle(t);

    const ship = targetFleet.find(
      (candidate) =>
        candidate.cells.length > 1
    );

    // Обстреливаем весь корабль по клеткам.
    for (
      const cell of ship.cells
    ) {
      await pause();

      const mark = shooter.mark();

      shooter.send({
        type: "fire",
        x: cell.x,
        y: cell.y
      });

      const state =
        await shooter.waitAfter(
          mark,
          (message) =>
            message.type === "state" ||
            message.type === "error"
        );

      assert.equal(
        state.type,
        "state",
        "выстрел принят без ошибки"
      );

      assert.equal(
        state.turn,
        "self",
        "после каждого попадания ход остаётся у стрелка"
      );
    }

    // Журнал есть в каждом state, поэтому берём
    // только последнее состояние, иначе события
    // посчитаются многократно.
    const finalState =
      shooter.received.findLast(
        isBattleState
      );

    const texts = (
      finalState?.events || []
    ).map((event) => event.text);

    const wounded = texts.filter((text) =>
      text.includes("Попал - ранил")
    );

    const killed = texts.filter((text) =>
      text.includes("Попал - Убил")
    );

    assert.equal(
      wounded.length,
      ship.cells.length - 1,
      "на каждую палубу кроме последней — «Попал - ранил»"
    );

    assert.equal(
      killed.length,
      1,
      "на последнюю палубу — ровно одно «Попал - Убил»"
    );
  }
);