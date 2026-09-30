import test from "node:test";
import assert from "node:assert/strict";

import {
  applyAttack,
  canPlaceShip,
  chooseBotTarget,
  createRandomFleet,
  isFleetDestroyed,
  validateFleet
} from "../public/shared/rules.mjs";

test(
  "Случайный флот соответствует правилам",
  () => {
    const fleet =
      createRandomFleet();

    assert.equal(
      validateFleet(fleet).length,
      10
    );

    assert.equal(
      fleet.filter(
        (ship) =>
          ship.cells.length === 4
      ).length,
      1
    );

    assert.equal(
      fleet.filter(
        (ship) =>
          ship.cells.length === 3
      ).length,
      2
    );

    assert.equal(
      fleet.filter(
        (ship) =>
          ship.cells.length === 2
      ).length,
      3
    );

    assert.equal(
      fleet.filter(
        (ship) =>
          ship.cells.length === 1
      ).length,
      4
    );
  }
);

test(
  "Корабли не могут соприкасаться",
  () => {
    const firstShip = [
      { x: 2, y: 2 },
      { x: 3, y: 2 }
    ];

    assert.equal(
      canPlaceShip(firstShip, []),
      true
    );

    const diagonalNeighbour = [
      { x: 4, y: 3 }
    ];

    assert.equal(
      canPlaceShip(
        diagonalNeighbour,
        [
          {
            id: "first",
            cells: firstShip
          }
        ]
      ),
      false
    );
  }
);

test(
  "Нельзя дважды стрелять в одну клетку",
  () => {
    const fleet =
      createRandomFleet();

    const attacks = [];

    const target =
      fleet[0].cells[0];

    applyAttack(
      fleet,
      attacks,
      target.x,
      target.y
    );

    assert.throws(
      () => {
        applyAttack(
          fleet,
          attacks,
          target.x,
          target.y
        );
      },
      /уже стреляли/
    );
  }
);

test(
  "Результат попадания и потопления корректен",
  () => {
    const fleet = [
      {
        id: "ship-1",
        cells: [
          { x: 0, y: 0 },
          { x: 1, y: 0 }
        ]
      },
      {
        id: "ship-2",
        cells: [
          { x: 0, y: 4 }
        ]
      }
    ];

    const attacks = [];

    const first =
      applyAttack(
        fleet,
        attacks,
        0,
        0
      );

    assert.equal(
      first.result,
      "hit"
    );

    assert.equal(
      first.sunk,
      false
    );

    const second =
      applyAttack(
        fleet,
        attacks,
        1,
        0
      );

    assert.equal(
      second.result,
      "hit"
    );

    assert.equal(
      second.sunk,
      true
    );

    assert.equal(
      isFleetDestroyed(
        fleet,
        attacks
      ),
      false
    );

    applyAttack(
      fleet,
      attacks,
      0,
      4
    );

    assert.equal(
      isFleetDestroyed(
        fleet,
        attacks
      ),
      true
    );
  }
);

test(
  "Промах определяется отдельно от попадания",
  () => {
    const fleet = [
      {
        id: "ship-1",
        cells: [
          { x: 0, y: 0 },
          { x: 1, y: 0 }
        ]
      }
    ];

    const attacks = [];

    const result =
      applyAttack(
        fleet,
        attacks,
        9,
        9
      );

    assert.equal(
      result.result,
      "miss"
    );

    assert.equal(
      result.sunk,
      false
    );
  }
);

test(
  "Бот выбирает только необстрелянную клетку",
  () => {
    const fleet =
      createRandomFleet();

    const attacks = [];

    for (
      let step = 0;
      step < 40;
      step += 1
    ) {
      const target =
        chooseBotTarget(
          attacks
        );

      assert.ok(target);

      assert.equal(
        attacks.some(
          (attack) =>
            attack.x ===
              target.x &&
            attack.y ===
              target.y
        ),
        false
      );

      applyAttack(
        fleet,
        attacks,
        target.x,
        target.y
      );
    }
  }
);