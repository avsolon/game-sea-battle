window.SEA_BATTLE_CONFIG = {
  /*
   * Для локального запуска оставьте пустую строку.
   *
   * Для Яндекс Игр укажите публичный WSS-адрес:
   * serverUrl: "wss://game.example.ru/ws"
   */
  serverUrl: "",

  fullscreenAdEveryRounds: 3,

  /*
   * SDK Яндекс Игр. undefined = автоопределение: грузится только внутри
   * Яндекса, во встроенном iframe или на localhost. На стороннем сайте
   * поставьте false.
   */
  yandexSdk: undefined
};