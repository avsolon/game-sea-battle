export const BOARD_SIZE = 10;

export const FLEET_LAYOUT = Object.freeze([
  Object.freeze({ size: 4, count: 1 }),
  Object.freeze({ size: 3, count: 2 }),
  Object.freeze({ size: 2, count: 3 }),
  Object.freeze({ size: 1, count: 4 })
]);

const cellKey = (x, y) => `${x}:${y}`;

function isCoordinate(value) {
  return (
    Number.isInteger(value?.x) &&
    Number.isInteger(value?.y) &&
    value.x >= 0 &&
    value.y >= 0 &&
    value.x < BOARD_SIZE &&
    value.y < BOARD_SIZE
  );
}

function isStraightShip(cells, size) {
  if (cells.length !== size) {
    return false;
  }

  const xs = cells.map((cell) => cell.x);
  const ys = cells.map((cell) => cell.y);
  const uniqueX = new Set(xs);
  const uniqueY = new Set(ys);

  const horizontal =
    uniqueY.size === 1 &&
    uniqueX.size === size &&
    Math.max(...xs) - Math.min(...xs) === size - 1;

  const vertical =
    uniqueX.size === 1 &&
    uniqueY.size === size &&
    Math.max(...ys) - Math.min(...ys) === size - 1;

  return horizontal || vertical;
}

/**
 * Проверяет геометрию любого количества кораблей.
 * Используется также при ручной расстановке.
 */
export function normalizeShips(input) {
  if (!Array.isArray(input)) {
    throw new Error("Некорректный формат флота.");
  }

  const occupied = new Set();
  const ids = new Set();

  const ships = input.map((ship, shipIndex) => {
    if (!ship || typeof ship !== "object") {
      throw new Error("Некорректный корабль.");
    }

    const id = ship.id == null ? `ship-${shipIndex + 1}` : String(ship.id);

    if (!id || id.length > 48) {
      throw new Error("Некорректный идентификатор корабля.");
    }

    if (ids.has(id)) {
      throw new Error("Идентификаторы кораблей должны быть уникальными.");
    }

    ids.add(id);

    if (!Array.isArray(ship.cells)) {
      throw new Error("У корабля отсутствуют клетки.");
    }

    const cells = ship.cells.map((cell) => ({
      x: cell?.x,
      y: cell?.y
    }));

    if (cells.some((cell) => !isCoordinate(cell))) {
      throw new Error("Один или несколько кораблей выходят за границы поля.");
    }

    const uniqueCells = new Set(
      cells.map((cell) => cellKey(cell.x, cell.y))
    );

    if (uniqueCells.size !== cells.length) {
      throw new Error("В корабле не может быть повторяющихся клеток.");
    }

    if (!isStraightShip(cells, cells.length)) {
      throw new Error("Каждый корабль должен занимать прямую линию.");
    }

    for (const cell of cells) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          const isSameCell =
            offsetX === 0 && offsetY === 0;

          const neighbourKey = cellKey(
            cell.x + offsetX,
            cell.y + offsetY
          );

          if (!isSameCell && occupied.has(neighbourKey)) {
            throw new Error(
              "Корабли не могут соприкасаться даже по диагонали."
            );
          }
        }
      }
    }

    for (const cell of cells) {
      occupied.add(cellKey(cell.x, cell.y));
    }

    return {
      id,
      cells
    };
  });

  return ships;
}

/**
 * Проверяет частичный флот и возможность добавить корабль.
 */
export function canPlaceShip(cells, fleet = []) {
  try {
    normalizeShips([
      ...fleet,
      {
        id: `candidate-${Math.random().toString(36).slice(2)}`,
        cells
      }
    ]);

    return true;
  } catch {
    return false;
  }
}

/**
 * Проверяет полный флот по стандартным правилам.
 */
export function validateFleet(input) {
  const ships = normalizeShips(input);
  const expectedCount = FLEET_LAYOUT.reduce(
    (sum, definition) => sum + definition.count,
    0
  );

  if (ships.length !== expectedCount) {
    throw new Error("Флот должен содержать 10 кораблей.");
  }

  for (const definition of FLEET_LAYOUT) {
    const actualCount = ships.filter(
      (ship) => ship.cells.length === definition.size
    ).length;

    if (actualCount !== definition.count) {
      throw new Error(
        `Неверное количество кораблей длиной ${definition.size}.`
      );
    }
  }

  return ships;
}

/**
 * Создаёт случайный допустимый флот.
 */
export function createRandomFleet(random = Math.random) {
  const ships = [];
  let sequence = 0;

  for (const definition of FLEET_LAYOUT) {
    for (let index = 0; index < definition.count; index += 1) {
      let placed = false;

      for (let attempt = 0; attempt < 10000 && !placed; attempt += 1) {
        const horizontal = random() < 0.5;
        const size = definition.size;

        const maxX = horizontal ? BOARD_SIZE - size : BOARD_SIZE - 1;
        const maxY = horizontal ? BOARD_SIZE - 1 : BOARD_SIZE - size;

        const startX = Math.floor(random() * (maxX + 1));
        const startY = Math.floor(random() * (maxY + 1));

        const cells = Array.from({ length: size }, (_, cellIndex) => ({
          x: horizontal ? startX + cellIndex : startX,
          y: horizontal ? startY : startY + cellIndex
        }));

        if (canPlaceShip(cells, ships)) {
          ships.push({
            id: `ship-${size}-${sequence}`,
            cells
          });

          sequence += 1;
          placed = true;
        }
      }

      if (!placed) {
        throw new Error("Не удалось создать допустимый флот.");
      }
    }
  }

  return ships;
}

export function getShipAt(fleet, x, y) {
  return fleet.find((ship) =>
    ship.cells.some((cell) => cell.x === x && cell.y === y)
  );
}

export function isFleetDestroyed(fleet, attacks) {
  const attacked = new Set(
    attacks.map((attack) => cellKey(attack.x, attack.y))
  );

  return fleet.every((ship) =>
    ship.cells.every((cell) =>
      attacked.has(cellKey(cell.x, cell.y))
    )
  );
}

/**
 * Авторитетная серверная атака.
 * Возвращает только публичную информацию о результате.
 */
export function applyAttack(fleet, attacks, x, y) {
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= BOARD_SIZE ||
    y >= BOARD_SIZE
  ) {
    throw new Error("Некорректные координаты выстрела.");
  }

  const key = cellKey(x, y);

  if (attacks.some((attack) => cellKey(attack.x, attack.y) === key)) {
    throw new Error("По этой клетке уже стреляли.");
  }

  const ship = getShipAt(fleet, x, y);
  const result = {
    x,
    y,
    result: ship ? "hit" : "miss",
    sunk: false,
    at: Date.now()
  };

  if (ship) {
    const attacked = new Set([
      ...attacks.map((attack) => cellKey(attack.x, attack.y)),
      key
    ]);

    result.sunk = ship.cells.every((cell) =>
      attacked.has(cellKey(cell.x, cell.y))
    );
  }

  attacks.push(result);
  return { ...result };
}

function randomItem(items, random = Math.random) {
  if (items.length === 0) {
    return null;
  }

  return items[Math.floor(random() * items.length)];
}

function chooseBestCell(cells, attacksByKey, random) {
  let bestScore = -Infinity;
  let bestCells = [];

  for (const cell of cells) {
    let score = cell.x + cell.y === 0 ? 0 : 0;
    score += (cell.x + cell.y) % 2 === 0 ? 2 : 0;

    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        if (offsetX === 0 && offsetY === 0) {
          continue;
        }

        const neighbour = {
          x: cell.x + offsetX,
          y: cell.y + offsetY
        };

        if (
          neighbour.x >= 0 &&
          neighbour.y >= 0 &&
          neighbour.x < BOARD_SIZE &&
          neighbour.y < BOARD_SIZE &&
          !attacksByKey.has(cellKey(neighbour.x, neighbour.y))
        ) {
          score += 2;
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestCells = [cell];
    } else if (score === bestScore) {
      bestCells.push(cell);
    }
  }

  return randomItem(bestCells, random);
}

/**
 * Стратегия бота:
 * сначала клетки чётной шахматной раскраски,
 * после попадания — соседние клетки.
 */
export function chooseBotTarget(attacks, random = Math.random) {
  const attacksByKey = new Set(
    attacks.map((attack) => cellKey(attack.x, attack.y))
  );

  const hitCells = attacks
    .filter((attack) => attack.result === "hit")
    .map((attack) => ({ x: attack.x, y: attack.y }));

  const sunkCells = new Set();

  const fleet = [
    ...attacks
      .filter((attack) => attack.sunk)
      .map((attack) => cellKey(attack.x, attack.y))
  ];

  for (const key of fleet) {
    sunkCells.add(key);
  }

  const activeHitCells = hitCells.filter(
    (cell) => !sunkCells.has(cellKey(cell.x, cell.y))
  );

  const adjacentTargets = new Map();

  for (const hit of activeHitCells) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        if (offsetX === 0 && offsetY === 0) {
          continue;
        }

        const candidate = {
          x: hit.x + offsetX,
          y: hit.y + offsetY
        };

        if (
          candidate.x < 0 ||
          candidate.y < 0 ||
          candidate.x >= BOARD_SIZE ||
          candidate.y >= BOARD_SIZE
        ) {
          continue;
        }

        const key = cellKey(candidate.x, candidate.y);

        if (!attacksByKey.has(key)) {
          adjacentTargets.set(key, candidate);
        }
      }
    }
  }

  if (adjacentTargets.size > 0) {
    return chooseBestCell(
      [...adjacentTargets.values()],
      attacksByKey,
      random
    );
  }

  const unshotCells = [];

  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (!attacksByKey.has(cellKey(x, y))) {
        unshotCells.push({ x, y });
      }
    }
  }

  const parityCells = unshotCells.filter(
    (cell) => (cell.x + cell.y) % 2 === 0
  );

  const firstTargets =
    parityCells.length > 0 ? parityCells : unshotCells;

  const secondTargets =
    parityCells.length > 0 ? unshotCells : parityCells;

  return (
    chooseBestCell(firstTargets, attacksByKey, random) ||
    chooseBestCell(secondTargets, attacksByKey, random)
  );
}