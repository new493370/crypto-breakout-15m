export const CONFIG = {
  OKX_BASE_URL: "https://www.okx.com",
  BINANCE_FUTURES_URL: "https://fapi1.binance.com",
  BINANCE_SPOT_URL: "https://data-api.binance.vision",
  MEXC_BASE_URL: "https://contract.mexc.com",

  TIMEFRAME: "5m",
  SWING_LEFT: 3,
  SWING_RIGHT: 3,
  MIN_SWING_DISTANCE: 8,
  MIN_LEVEL_DIFF_PERCENT: 0.05,
  MIN_CANDLES_BETWEEN_PIVOTS: 3,

  BREAKOUT_CONFIRMATION_BARS: 10,
  STOP_ATR_MULTIPLIER: 1.5,
  TARGET_ZONE_MULTIPLIER: 2,

  MIN_CANDLES: 99,
  KLINE_LIMIT: 150,
  MARKET_TIMEOUT: 15000,
  MARKET_TOP_LIMIT: 1000,
  MIN_QUOTE_VOLUME_24H: 1000000,
  SYMBOL_CACHE_SECONDS: 3600,
  KLINE_CACHE_SECONDS: 15,

  EXCHANGES: {
    binance: {
      priority: 1,
      enabled: true,
      maxCandles: 1000,
      marketType: "futures"
    },
    okx: {
      priority: 2,
      enabled: true,
      maxCandles: 300,
      marketType: "swap"
    },
    mexc: {
      priority: 3,
      enabled: true,
      maxCandles: 1000,
      marketType: "swap"
    }
  },

  SYMBOL_ALIASES: {
    SHIBUSDT: ["1000SHIBUSDT", "SHIB1000USDT"],
    PEPEUSDT: ["1000PEPEUSDT", "PEPE1000USDT"],
    FLOKIUSDT: ["1000FLOKIUSDT", "FLOKI1000USDT"],
    BONKUSDT: ["1000BONKUSDT", "BONK1000USDT"],
    LUNCUSDT: ["1000LUNCUSDT", "LUNC1000USDT"],
    XECUSDT: ["1000XECUSDT", "XEC1000USDT"],
    SATSUSDT: ["1000SATSUSDT", "SATS1000USDT"],
    RATSUSDT: ["1000RATSUSDT", "RATS1000USDT"],
    MOGUSDT: ["1000MOGUSDT", "MOG1000USDT"],
    CATUSDT: ["1000CATUSDT", "CAT1000USDT"]
  },

  EXCLUDED_BASE_ASSETS: [
    "USDT",
    "USDC",
    "FDUSD",
    "TUSD",
    "BUSD",
    "DAI",
    "USDE",
    "USDS",
    "EUR",
    "TRY",
    "BRL",
    "GBP",
    "AUD",
    "JPY",
    "RUB",
    "UAH",
    "PLN",
    "ARS",
    "MXN",
    "ZAR"
  ],

  TIMEFRAMES: {
    "5m": "5 دقیقه",
    "1h": "1 ساعت"
  },

  OKX_INTERVAL_MAP: {
    "5m": "5m",
    "1h": "1H"
  },

  BINANCE_INTERVAL_MAP: {
    "5m": "5m",
    "1h": "1h"
  },

  MEXC_INTERVAL_MAP: {
    "5m": "Min5",
    "1h": "Min60"
  }
};

export const INTERVAL_MS = {
  "5m": 5 * 60 * 1000,
  "1h": 60 * 60 * 1000
};
