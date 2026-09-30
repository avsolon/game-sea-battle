const YANDEX_SDK_URL =
  "https://yandex.ru/games/sdk/v2";

function withTimeout(promise, milliseconds) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error("Yandex SDK timeout")
      );
    }, milliseconds);
  });

  return Promise.race([
    promise,
    timeout
  ]).finally(() => {
    clearTimeout(timer);
  });
}

function loadSdkScript() {
  if (window.YaGames) {
    return Promise.resolve(window.YaGames);
  }

  const existingScript = document.querySelector(
    "script[data-yandex-games-sdk]"
  );

  if (existingScript) {
    return new Promise((resolve, reject) => {
      existingScript.addEventListener(
        "load",
        () => resolve(window.YaGames),
        { once: true }
      );

      existingScript.addEventListener(
        "error",
        () => reject(
          new Error("Не удалось загрузить SDK")
        ),
        { once: true }
      );
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = YANDEX_SDK_URL;
    script.async = true;
    script.dataset.yandexGamesSdk = "true";

    script.onload = () => {
      if (window.YaGames) {
        resolve(window.YaGames);
      } else {
        reject(
          new Error("SDK загружен, но YaGames недоступен")
        );
      }
    };

    script.onerror = () => {
      reject(
        new Error("Ошибка загрузки SDK")
      );
    };

    document.head.appendChild(script);
  });
}

export function createPlatform() {
  const documentElement = document.documentElement;

  const requestFullscreen =
    documentElement.requestFullscreen ||
    documentElement.webkitRequestFullscreen;

  const exitFullscreen =
    document.exitFullscreen ||
    documentElement.webkitExitFullscreen ||
    document.webkitExitFullscreen;

  const fullscreenElement =
    () =>
      document.fullscreenElement ||
      document.webkitFullscreenElement;

  return {
    available: false,
    adBusy: false,
    sdk: null,

    async init() {
      try {
        const yaGames = await withTimeout(
          loadSdkScript(),
          8000
        );

        this.sdk = await withTimeout(
          yaGames.init(),
          8000
        );

        this.available = true;
      } catch {
        this.available = false;
      }
    },

    ready() {
      try {
        this.sdk
          ?.features
          ?.LoadingAPI
          ?.ready?.();
      } catch {
        // Игра продолжает работать без SDK.
      }
    },

    gameplayStart() {
      try {
        this.sdk
          ?.features
          ?.GameplayAPI
          ?.start?.();
      } catch {
        // Не критично для локального запуска.
      }
    },

    gameplayStop() {
      try {
        this.sdk
          ?.features
          ?.GameplayAPI
          ?.stop?.();
      } catch {
        // Не критично для локального запуска.
      }
    },

    getLanguage() {
      return (
        this.sdk?.environment?.i18n?.lang ||
        document.documentElement.lang ||
        "ru"
      );
    },

    showFullscreenAd() {
      if (
        !this.available ||
        this.adBusy ||
        typeof this.sdk?.adv?.showFullscreenAdv !== "function"
      ) {
        return Promise.resolve(false);
      }

      this.adBusy = true;

      return new Promise((resolve) => {
        let completed = false;

        const finish = (result) => {
          if (completed) {
            return;
          }

          completed = true;
          this.adBusy = false;
          resolve(result);
        };

        try {
          this.sdk.adv.showFullscreenAdv({
            callbacks: {
              onOpen() {
                // Реклама открыта.
              },

              onClose() {
                finish(true);
              },

              onError() {
                finish(false);
              }
            }
          });
        } catch {
          finish(false);
        }
      });
    },

    canUseFullscreen() {
      return Boolean(requestFullscreen && exitFullscreen);
    },

    isFullscreen() {
      return Boolean(fullscreenElement());
    },

    async toggleFullscreen() {
      if (!this.canUseFullscreen()) {
        return false;
      }

      try {
        if (fullscreenElement()) {
          await exitFullscreen.call(document);
        } else {
          await requestFullscreen.call(documentElement, {
            navigationUI: "hide"
          });
        }

        return true;
      } catch {
        return false;
      }
    }
  };
}