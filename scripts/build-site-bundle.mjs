/**
 * Сборка полностью автономного фронта игры для размещения на сайте.
 *
 *   node scripts/build-site-bundle.mjs
 *
 * На выходе:
 *   dist/sea-battle.html      — ОДИН файл со всем frontend'ом
 *                                (стили, JS, логика, картинка внутри).
 *                                Кладётся в папку сайта как sea-battle.html.
 *                                С backend нужен только WebSocket.
 *   dist/sea-battle/          — вариант с отдельными файлами (на случай, если
 *                                однофайловый не подходит): styles.css, game.js,
 *                                platform.js, shared/rules.mjs, баннер.
 *
 * Опции (переменные окружения):
 *   SEA_BATTLE_BANNER=off     — не встраивать картинку (страница станет ~110 КБ
 *                                вместо ~470 КБ, шапка будет градиентом).
 *   SEA_BATTLE_WS_PATH        — путь WebSocket, по умолчанию /sea-battle/ws
 *   SEA_BATTLE_SITE_URL       — адрес ссылки «на главную», по умолчанию /
 *   SEA_BATTLE_SITE_TITLE     — текст ссылки, по умолчанию «на главную»
 *
 * Скрипт валидирует результат и падает с ошибкой, если что-то поехало:
 *   - остались относительные пути к ассетам;
 *   - в собранном JS остались import/export;
 *   - синтаксис собранного JS не проходит node --check;
 *   - нашлись одинаковые объявления верхнего уровня в модулях (конфликт имён при склейке).
 */

import {
  readFile,
  mkdir,
  writeFile,
  rm,
  copyFile,
  mkdtemp
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const publicDirectory = path.join(projectRoot, "public");
const distDirectory = path.join(projectRoot, "dist");

const ASSET_PREFIX = "/sea-battle/";
const WS_PATH = process.env.SEA_BATTLE_WS_PATH ?? "/sea-battle/ws";
const SITE_URL = process.env.SEA_BATTLE_SITE_URL ?? "/";
const SITE_TITLE = process.env.SEA_BATTLE_SITE_TITLE ?? "на главную";
const INLINE_BANNER = (process.env.SEA_BATTLE_BANNER ?? "on") !== "off";

// Порядок важен: сначала модули без зависимостей, потом их потребитель.
const MODULES = ["shared/rules.mjs", "platform.js", "game.js"];

const read = (file) => readFile(path.join(publicDirectory, file), "utf8");

const html = await read("index.html");
const styles = await read("styles.css");
const modules = new Map();

for (const file of MODULES) {
  modules.set(file, await read(file));
}

const banner = await readFile(
  path.join(publicDirectory, "sea-battle-banner.jpg")
);

function fail(message) {
  throw new Error(`[build-site-bundle] ${message}`);
}

// --- 1. Склейка модулей в один классический скрипт ---------------------------

function topLevelNames(source, file) {
  const names = new Set();
  const pattern = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  let match;

  while ((match = pattern.exec(source))) {
    names.add(match[1]);
  }

  if (names.size === 0) {
    fail(`Не нашлосьобъявлений верхнего уровня в ${file} — склейка небезопасна.`);
  }

  return names;
}

const seenNames = new Map();
const parts = [];

for (const [file, source] of modules) {
  for (const name of topLevelNames(source, file)) {
    if (seenNames.has(name)) {
      fail(
        `Конфликт имён: «${name}» объявлен в ${seenNames.get(name)} и ${file}. ` +
          "Склейка модулей в один скрипт сломается."
      );
    }

    seenNames.set(name, file);
  }

  const cleaned = source
    // import { ... } from "./...";  (в т.ч. многострочный блок)
    .replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];?[ \t]*$/gm, "")
    // import "./...";
    .replace(/^import\s+["'][^"']+["'];?[ \t]*$/gm, "")
    // export const / let / function / class / async function
    .replace(/^export\s+(?=(?:const|let|var|function|class|async)\b)/gm, "");

  if (/^\s*(?:import|export)\s/m.test(cleaned)) {
    fail(`В ${file} остались import/export после очистки.`);
  }

  parts.push(`/* ===== ${file} ===== */\n${cleaned.trim()}\n`);
}

const bundle = `(function () {
"use strict";

${parts.join("\n")}
})();`;

// --- 2. Проверка синтаксиса собранного скрипта ------------------------------

// node --check не умеет читать stdin, поэтому пишем во временный файл.
const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "sea-battle-"));
const tempFile = path.join(tempDirectory, "bundle.js");
await writeFile(tempFile, bundle, "utf8");

const syntaxCheck = spawnSync(process.execPath, ["--check", tempFile], {
  encoding: "utf8"
});

await rm(tempDirectory, { recursive: true, force: true });

if (syntaxCheck.status !== 0) {
  fail(`Собранный JS не проходит node --check:\n${syntaxCheck.stderr}`);
}

// --- 3. Сборка страницы -----------------------------------------------------

const configBlock = `<script>
  // Адрес WebSocket считается от текущего хоста: страница работает
  // и на asolontsov.ru, и на превью без правок. С backend по HTTP не
  // общаемся вообще — весь фронт внутри этого файла.
  window.SEA_BATTLE_CONFIG = {
    serverUrl: (location.protocol === "https:" ? "wss://" : "ws://") +
      location.host + "${WS_PATH}",
    fullscreenAdEveryRounds: 3,
    yandexSdk: false
  };
</script>`;

const bannerTag = INLINE_BANNER
  ? `<img class="menu-banner" src="data:image/jpeg;base64,${banner.toString("base64")}"` +
    `\n            width="1200" height="675" alt="Морской бой">`
  : `<div class="menu-banner menu-banner--plain" role="img" aria-label="Морской бой"></div>`;

const bannerStyle = INLINE_BANNER
  ? ""
  : `.menu-banner--plain {
  min-height: 120px;
  background: linear-gradient(135deg, #123a52, #0a1d2e 60%, #14524f);
}`;

const replacements = [
  {
    find: `<link rel="stylesheet" href="./styles.css">`,
    replace: `<style>\n${styles}\n${bannerStyle}\n  </style>`
  },
  {
    find: `  <script src="./config.js"></script>`,
    replace: `  ${configBlock}`
  },
  {
    find: `<img
            class="menu-banner"
            src="./sea-battle-banner.jpg"
            width="1200"
            height="675"
            alt="Морской бой"
          >`,
    replace: bannerTag
  },
  {
    find: `<script type="module" src="./game.js"></script>`,
    replace: `<script>\n${bundle}\n</script>`
  },
  {
    find: `<footer class="menu-footer">`,
    replace: `<a class="site-back-link" href="${SITE_URL}">← ${SITE_TITLE}</a>

        <footer class="menu-footer">`
  }
];

let singleFileHtml = html;

for (const { find, replace } of replacements) {
  if (!singleFileHtml.includes(find)) {
    fail(`Не найден фрагмент в public/index.html:\n${find}`);
  }

  singleFileHtml = singleFileHtml.replace(find, replace);
}

if (singleFileHtml.includes('src="./') || singleFileHtml.includes('href="./')) {
  fail("В собранной странице остались относительные пути к ассетам.");
}

const header = `<!--
  Автономный фронт «Морского боя» — ОДИН файл.
  Собран: node scripts/build-site-bundle.mjs
  Внутри: стили, вся логика игры, изображение шапки.
  С backend общается только WebSocket: ${WS_PATH}
  Вручную не редактируйте — правьте public/ и пересобирайте.
-->
`;

await rm(distDirectory, { recursive: true, force: true });
await mkdir(distDirectory, { recursive: true });

const singleFilePath = path.join(distDirectory, "sea-battle.html");
await writeFile(singleFilePath, `${header}${singleFileHtml}`, "utf8");

// --- 4. Вариант с отдельными файлами ---------------------------------------

const variantDirectory = path.join(distDirectory, "sea-battle");
await mkdir(path.join(variantDirectory, "shared"), { recursive: true });

for (const file of ["styles.css", "game.js", "platform.js", "sea-battle-banner.jpg"]) {
  await copyFile(path.join(publicDirectory, file), path.join(variantDirectory, file));
}

await copyFile(
  path.join(publicDirectory, "shared", "rules.mjs"),
  path.join(variantDirectory, "shared", "rules.mjs")
);

const multiFileConfig = `window.SEA_BATTLE_CONFIG = {
  serverUrl: (location.protocol === "https:" ? "wss://" : "ws://") +
    location.host + "${WS_PATH}",
  fullscreenAdEveryRounds: 3,
  yandexSdk: false
};
`;

await writeFile(path.join(variantDirectory, "config.js"), multiFileConfig, "utf8");

let multiFileHtml = html;

for (const { find, replace } of replacements) {
  multiFileHtml = multiFileHtml.replace(find, replace);
}

await writeFile(
  path.join(distDirectory, "sea-battle-multi.html"),
  `${header}${multiFileHtml}`,
  "utf8"
);

const singleSize = (await readFile(singleFilePath)).length;

console.log(
  [
    "Готово:",
    `  dist/sea-battle.html        ${Math.round(singleSize / 1024)} КБ — один файл, кладёте в папку сайта`,
    `  dist/sea-battle-multi.html + dist/sea-battle/ — вариант с отдельными файлами`,
    `  WebSocket: ${WS_PATH}`,
    `  Шапка: ${INLINE_BANNER ? "картинка внутри файла" : "градиент (SEA_BATTLE_BANNER=off)"}`,
    `  Объявлений склеено: ${seenNames.size}, конфликтов имён нет`
  ].join("\n")
);
