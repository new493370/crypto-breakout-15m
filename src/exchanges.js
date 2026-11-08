import { CONFIG, INTERVAL_MS } from "./config.js";

const CACHE_TTL = {
  SYMBOLS: CONFIG.SYMBOL_CACHE_SECONDS,
  TICKERS: 300,
  KLINES: CONFIG.KLINE_CACHE_SECONDS,
  SNAPSHOT: 60
};

let symbolCache = {
  timestamp: 0,
  symbols: []
};

let tickersCache = {
  timestamp: 0,
  data: []
};

const klineCache = new Map();
const snapshotCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logWarning(label, error) {
  const message = error?.message || String(error || "Unknown error");
  console.warn(`[${label}] ${message}`);
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isValidOHLC(open, high, low, close) {
  return (
    Number.isFinite(open) &&
    Number.isFinite(high) &&
    Number.isFinite(low) &&
    Number.isFinite(close) &&
    open > 0 &&
    high > 0 &&
    low > 0 &&
    close > 0 &&
    high >= low &&
    high >= open &&
    high >= close &&
    low <= open &&
    low <= close
  );
}

function normalizeBaseAsset(value) {
  return String(value || "").trim().toUpperCase();
}

function isExcludedBase(base) {
  if (!base) return true;

  if (CONFIG.EXCLUDED_BASE_ASSETS.includes(base)) {
    return true;
  }

  if (/^X[A-Z]{4,}$/.test(base)) {
    return true;
  }

  if (base.includes("TEST")) {
    return true;
  }

  return false;
}

function parseSymbol(rawSymbol) {
  const raw = String(rawSymbol || "").trim().toUpperCase();

  if (!raw) return null;

  const base = raw
    .replace(/[-_/:\s]/g, "")
    .replace(/USDT$/, "");

  if (!base || isExcludedBase(base)) {
    return null;
  }

  return {
    symbol: `${base}USDT`,
    base,
    quote: "USDT"
  };
}

function getConfirmStatus(value) {
  if (value === false || value === 0 || value === "0") {
    return "0";
  }

  return "1";
}

async function genericFetch(
  baseUrl,
  path,
  params = {},
  options = {}
) {
  const url = new URL(baseUrl + path);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const maxAttempts = Math.max(
    1,
    Number(options.maxAttempts) || 3
  );

  const baseDelay = Math.max(
    100,
    Number(options.baseDelay) || 400
  );

  const timeoutMs =
    Number(options.timeout) || CONFIG.MARKET_TIMEOUT;

  const label = options.label || "HTTP";

  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json"
        },
        signal: controller.signal,
        redirect: "follow"
      });

      if (response.status === 429) {
        lastError = new Error(`${label} HTTP 429`);

        if (attempt === maxAttempts - 1) {
          break;
        }

        const retryAfter = response.headers.get("Retry-After");
        const retrySeconds = Number(retryAfter);

        const delay =
          Number.isFinite(retrySeconds) && retrySeconds > 0
            ? Math.min(retrySeconds * 1000, 15000)
            : baseDelay * (attempt + 1);

        await sleep(delay);
        continue;
      }

      if (response.status === 418) {
        lastError = new Error(`${label} IP banned (418)`);

        if (attempt === maxAttempts - 1) {
          break;
        }

        await sleep(
          Math.min(5000 * (attempt + 1), 30000)
        );

        continue;
      }

      if (!response.ok) {
        const error = new Error(
          `${label} HTTP ${response.status}`
        );

        error.status = response.status;

        const retryable = response.status >= 500;

        if (!retryable || attempt === maxAttempts - 1) {
          throw error;
        }

        lastError = error;

        await sleep(baseDelay * (attempt + 1));
        continue;
      }

      const json = await response.json();

      if (json === null || json === undefined) {
        throw new Error(`${label} پاسخ خالی دریافت کرد`);
      }

      return json;

    } catch (error) {
      lastError = error;

      const status = Number(error?.status || 0);

      const retryable =
        status === 429 ||
        status === 418 ||
        status >= 500 ||
        status === 0 ||
        error?.name === "AbortError";

      if (!retryable || attempt === maxAttempts - 1) {
        break;
      }

      await sleep(baseDelay * (attempt + 1));

    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error(`${label} خطای ناشناخته`);
}

// --------------------------------------------------
// EXCHANGE FETCHERS
// --------------------------------------------------

export function okxFetch(path, params = {}, options = {}) {
  return genericFetch(
    CONFIG.OKX_BASE_URL,
    path,
    params,
    {
      ...options,
      label: "OKX"
    }
  ).then((json) => {
    if (
      !json ||
      json.code !== "0"
    ) {
      throw new Error(
        "OKX error: " +
        (json?.msg || json?.code || "unknown")
      );
    }

    return json;
  });
}

export function binanceFetch(path, params = {}, options = {}) {
  return genericFetch(
    CONFIG.BINANCE_SPOT_URL,
    path,
    params,
    {
      ...options,
      label: "Binance"
    }
  );
}

export function binanceSpotFetch(path, params = {}, options = {}) {
  return genericFetch(
    CONFIG.BINANCE_SPOT_URL,
    path,
    params,
    {
      ...options,
      label: "BinanceSpot"
    }
  );
}

export function mexcFetch(path, params = {}, options = {}) {
  return genericFetch(
    CONFIG.MEXC_BASE_URL,
    path,
    params,
    {
      ...options,
      label: "MEXC"
    }
  ).then((json) => {
    if (
      json &&
      json.code !== undefined &&
      json.code !== 0 &&
      json.code !== "0" &&
      json.code !== 200
    ) {
      throw new Error(
        "MEXC error: " +
        (json.message || json.msg || json.code || "unknown")
      );
    }

    return json;
  });
}

// --------------------------------------------------
// SYMBOL ALIASES
// --------------------------------------------------

export function resolveSymbolAliases(symbol) {
  const normalized = String(symbol || "")
    .toUpperCase()
    .replace(/[-_/:\s]/g, "");

  const aliases = CONFIG.SYMBOL_ALIASES?.[normalized];

  if (Array.isArray(aliases) && aliases.length > 0) {
    return [
      normalized,
      ...aliases.map((item) =>
        String(item).toUpperCase().replace(/[-_/:\s]/g, "")
      )
    ];
  }

  return [normalized];
}

// --------------------------------------------------
// EXCHANGE SYMBOLS
// --------------------------------------------------

export async function getExchangeSymbols(force = false) {
  const now = Date.now() / 1000;

  if (
    !force &&
    symbolCache.symbols.length > 0 &&
    now - symbolCache.timestamp < CACHE_TTL.SYMBOLS
  ) {
    return symbolCache.symbols;
  }

  const allSymbols = new Map();

  const errors = [];

  // BINANCE

  try {
    const json = await binanceFetch(
      "/api/v3/exchangeInfo"
    );

    if (Array.isArray(json?.symbols)) {
      for (const item of json.symbols) {
        if (item.status !== "TRADING") continue;
        if (item.quoteAsset !== "USDT") continue;

        const base = normalizeBaseAsset(item.baseAsset);

        if (isExcludedBase(base)) continue;

        const symbol = `${base}USDT`;

        allSymbols.set(symbol, {
          symbol,
          base,
          quote: "USDT",
          exchange: "binance"
        });
      }
    }

  } catch (error) {
    errors.push(error);
    logWarning("Binance Symbols", error);
  }

  // OKX SWAP

  try {
    const json = await okxFetch(
      "/api/v5/public/instruments",
      {
        instType: "SWAP"
      }
    );

    if (Array.isArray(json?.data)) {
      for (const item of json.data) {
        if (item.state !== "live") continue;
        if (item.settleCcy !== "USDT") continue;

        const instId = String(item.instId || "");

        if (!instId.endsWith("-USDT-SWAP")) {
          continue;
        }

        const base = normalizeBaseAsset(
          item.ctValCcy || item.baseCcy
        );

        if (isExcludedBase(base)) continue;

        const symbol = `${base}USDT`;

        if (!allSymbols.has(symbol)) {
          allSymbols.set(symbol, {
            symbol,
            base,
            quote: "USDT",
            exchange: "okx"
          });
        }
      }
    }

  } catch (error) {
    errors.push(error);
    logWarning("OKX Symbols", error);
  }

  // MEXC CONTRACT

  try {
    const json = await mexcFetch(
      "/api/v1/contract/detail"
    );

    if (Array.isArray(json?.data)) {
      for (const item of json.data) {
        if (item.state !== 0) continue;
        if (item.quoteCoin !== "USDT") continue;

        const base = normalizeBaseAsset(item.baseCoin);

        if (isExcludedBase(base)) continue;

        const symbol = `${base}USDT`;

        if (!allSymbols.has(symbol)) {
          allSymbols.set(symbol, {
            symbol,
            base,
            quote: "USDT",
            exchange: "mexc"
          });
        }
      }
    }

  } catch (error) {
    errors.push(error);
    logWarning("MEXC Symbols", error);
  }

  const result = Array.from(allSymbols.values());

  result.sort((a, b) =>
    a.symbol.localeCompare(b.symbol)
  );

  if (result.length === 0 && errors.length > 0) {
    throw new Error(
      "دریافت لیست نمادها از تمام صرافی‌ها ناموفق بود"
    );
  }

  symbolCache = {
    timestamp: now,
    symbols: result
  };

  return result;
}

// --------------------------------------------------
// TICKERS
// --------------------------------------------------

export async function getTickers(force = false) {
  const now = Date.now() / 1000;

  if (
    !force &&
    tickersCache.data.length > 0 &&
    now - tickersCache.timestamp < CACHE_TTL.TICKERS
  ) {
    return tickersCache.data;
  }

  const validSymbols = await getExchangeSymbols();

  const validSet = new Set(
    validSymbols.map((item) => item.symbol)
  );

  const result = [];
  const seen = new Set();

  // BINANCE

  try {
    const json = await binanceFetch(
      "/api/v3/ticker/24hr"
    );

    if (Array.isArray(json)) {
      for (const item of json) {
        const parsed = parseSymbol(item.symbol);

        if (!parsed) continue;
        if (!validSet.has(parsed.symbol)) continue;
        if (seen.has(parsed.symbol)) continue;

        const last = toNumber(item.lastPrice);
        const open24h = toNumber(item.openPrice);
        const quoteVolume = toNumber(item.quoteVolume);

        if (last <= 0) continue;

        const changePercent =
          open24h > 0
            ? ((last - open24h) / open24h) * 100
            : 0;

        result.push({
          ...parsed,
          price: last,
          change: changePercent,
          quote_volume: quoteVolume
        });

        seen.add(parsed.symbol);
      }
    }

  } catch (error) {
    logWarning("Binance Tickers", error);
  }

  // OKX SWAP

  try {
    const json = await okxFetch(
      "/api/v5/market/tickers",
      {
        instType: "SWAP"
      }
    );

    if (Array.isArray(json?.data)) {
      for (const item of json.data) {
        const instId = String(item.instId || "");

        if (!instId.endsWith("-USDT-SWAP")) {
          continue;
        }

        const base = normalizeBaseAsset(
          instId.split("-")[0]
        );

        if (isExcludedBase(base)) continue;

        const symbol = `${base}USDT`;

        if (!validSet.has(symbol)) continue;
        if (seen.has(symbol)) continue;

        const last = toNumber(item.last);
        const open24h = toNumber(item.open24h);
        const volCcy24h = toNumber(item.volCcy24h);
        const vol24h = toNumber(item.vol24h);

        if (last <= 0) continue;

        const quoteVolume =
          volCcy24h > 0
            ? volCcy24h
            : vol24h > 0
              ? vol24h * last
              : 0;

        const changePercent =
          open24h > 0
            ? ((last - open24h) / open24h) * 100
            : 0;

        result.push({
          symbol,
          base,
          quote: "USDT",
          price: last,
          change: changePercent,
          quote_volume: quoteVolume
        });

        seen.add(symbol);
      }
    }

  } catch (error) {
    logWarning("OKX Tickers", error);
  }

  // MEXC CONTRACT

  try {
    const json = await mexcFetch(
      "/api/v1/contract/ticker"
    );

    if (Array.isArray(json?.data)) {
      for (const item of json.data) {
        const parsed = parseSymbol(item.symbol);

        if (!parsed) continue;
        if (!validSet.has(parsed.symbol)) continue;
        if (seen.has(parsed.symbol)) continue;

        const last = toNumber(item.lastPrice);

        if (last <= 0) continue;

        const amount24 = toNumber(item.amount24);
        const volume24 = toNumber(item.volume24);

        const quoteVolume =
          amount24 > 0
            ? amount24
            : volume24 > 0
              ? volume24 * last
              : 0;

        const riseFallRate = toNumber(
          item.riseFallRate
        );

        const changePercent =
          riseFallRate * 100;

        result.push({
          ...parsed,
          price: last,
          change: changePercent,
          quote_volume: quoteVolume
        });

        seen.add(parsed.symbol);
      }
    }

  } catch (error) {
    logWarning("MEXC Tickers", error);
  }

  result.sort(
    (a, b) => b.quote_volume - a.quote_volume
  );

  if (result.length === 0) {
    console.warn(
      "[Tickers] هیچ تیکر معتبری دریافت نشد"
    );
  }

  tickersCache = {
    timestamp: now,
    data: result
  };

  return result;
}

// --------------------------------------------------
// TOP SYMBOLS
// --------------------------------------------------

export async function getTopSymbols(
  limit = CONFIG.MARKET_TOP_LIMIT
) {
  const symbols = await getExchangeSymbols();
  const tickers = await getTickers();

  const allowed = new Set(
    symbols.map((item) => item.symbol)
  );

  const ranked = [];

  for (const ticker of tickers) {
    if (!allowed.has(ticker.symbol)) continue;

    if (
      !Number.isFinite(ticker.quote_volume) ||
      ticker.quote_volume < CONFIG.MIN_QUOTE_VOLUME_24H
    ) {
      continue;
    }

    ranked.push(ticker);
  }

  ranked.sort(
    (a, b) => b.quote_volume - a.quote_volume
  );

  const safeLimit = Math.max(
    0,
    Math.min(
      Number(limit) || CONFIG.MARKET_TOP_LIMIT,
      1000
    )
  );

  return ranked.slice(0, safeLimit);
}

// --------------------------------------------------
// CANDLE NORMALIZATION
// --------------------------------------------------

export function normalizeCandles(rawCandles, interval) {
  if (!Array.isArray(rawCandles)) {
    return [];
  }

  const intervalMs = INTERVAL_MS[interval] || 0;

  const normalized = [];
  const incompleteCandles = [];

  const now = Date.now();

  for (const raw of rawCandles) {
    const openTime = toNumber(raw.time, NaN);

    const open = toNumber(raw.open, NaN);
    const high = toNumber(raw.high, NaN);
    const low = toNumber(raw.low, NaN);
    const close = toNumber(raw.close, NaN);

    const volume = toNumber(raw.volume);
    const quoteVolume = toNumber(raw.quoteVolume);

    if (!Number.isFinite(openTime)) continue;

    if (!isValidOHLC(open, high, low, close)) {
      continue;
    }

    const closeTime =
      intervalMs > 0
        ? openTime + intervalMs - 1
        : openTime;

    const isIncomplete =
      getConfirmStatus(raw.confirm) === "0";

    const candle = {
      time: openTime,
      open_time: openTime,
      close_time: closeTime,

      open,
      high,
      low,
      close,

      volume,
      quote_volume: quoteVolume,

      trades: 0,
      incomplete: isIncomplete
    };

    if (isIncomplete) {
      incompleteCandles.push(candle);
    } else {
      normalized.push(candle);
    }
  }

  normalized.sort(
    (a, b) => a.time - b.time
  );

  // فقط آخرین کندل ناقص به خروجی اضافه می‌شود.
  // این کندل برای نمایش قیمت جاری است، نه تحلیل ساختار.

  if (incompleteCandles.length > 0) {
    incompleteCandles.sort(
      (a, b) => a.time - b.time
    );

    const openCandle =
      incompleteCandles[incompleteCandles.length - 1];

    if (
      normalized.length === 0 ||
      openCandle.time > normalized[normalized.length - 1].time
    ) {
      normalized.push({
        ...openCandle,
        updated_at: now
      });
    }
  }

  // حذف کندل‌های تکراری

  const unique = [];
  const seen = new Set();

  for (const candle of normalized) {
    if (seen.has(candle.time)) continue;

    seen.add(candle.time);
    unique.push(candle);
  }

  unique.sort(
    (a, b) => a.time - b.time
  );

  return unique;
}

// --------------------------------------------------
// BINANCE KLINES
// --------------------------------------------------

async function getKlinesBinance(
  symbol,
  interval,
  limit
) {
  const binanceSymbol = symbol.toUpperCase();

  const binanceInterval =
    CONFIG.BINANCE_INTERVAL_MAP[interval];

  if (!binanceInterval) {
    throw new Error(
      "Binance interval unsupported: " + interval
    );
  }

  const size = Math.max(
    1,
    Math.min(Number(limit) || 300, 1000)
  );

  const json = await binanceSpotFetch(
    "/api/v3/klines",
    {
      symbol: binanceSymbol,
      interval: binanceInterval,
      limit: String(size)
    }
  );

  if (!Array.isArray(json)) {
    throw new Error(
      "Binance klines پاسخ نامعتبر"
    );
  }

  const rawCandles = [];

  const intervalMs =
    INTERVAL_MS[interval] || 3600000;

  const now = Date.now();

  for (const row of json) {
    if (!Array.isArray(row) || row.length < 6) {
      continue;
    }

    const openTime = parseInt(row[0], 10);

    const open = parseFloat(row[1]);
    const high = parseFloat(row[2]);
    const low = parseFloat(row[3]);
    const close = parseFloat(row[4]);

    const volume = parseFloat(row[5]);
    const turnover = parseFloat(row[7] || "0");

    if (
      !Number.isFinite(openTime) ||
      !isValidOHLC(open, high, low, close)
    ) {
      continue;
    }

    const closeTime =
      openTime + intervalMs - 1;

    const isClosed = now > closeTime;

    rawCandles.push({
      time: openTime,
      open,
      high,
      low,
      close,
      volume,
      quoteVolume: turnover,
      confirm: isClosed ? "1" : "0"
    });
  }

  rawCandles.sort(
    (a, b) => a.time - b.time
  );

  return normalizeCandles(
    rawCandles,
    interval
  );
}

// --------------------------------------------------
// OKX KLINES
// --------------------------------------------------

async function getKlinesOKX(
  symbol,
  interval,
  limit
) {
  const base = symbol.replace(/USDT$/, "");

  const okxInterval =
    CONFIG.OKX_INTERVAL_MAP[interval];

  if (!okxInterval) {
    throw new Error(
      "OKX interval unsupported: " + interval
    );
  }

  const barLimit = Math.max(
    1,
    Math.min(Number(limit) || 300, 300)
  );

  const swapInstId =
    base + "-USDT-SWAP";

  // ابتدا SWAP

  try {
    const swapJson = await okxFetch(
      "/api/v5/market/candles",
      {
        instId: swapInstId,
        bar: okxInterval,
        limit: String(barLimit)
      },
      {
        maxAttempts: 3,
        baseDelay: 400
      }
    );

    if (
      Array.isArray(swapJson?.data) &&
      swapJson.data.length > 0
    ) {
      const rawCandles = swapJson.data.map((row) => ({
        time: parseInt(row[0], 10),

        open: parseFloat(row[1]),
        high: parseFloat(row[2]),
        low: parseFloat(row[3]),
        close: parseFloat(row[4]),

        volume: parseFloat(row[5]),
        quoteVolume: parseFloat(row[6]),

        confirm: getConfirmStatus(row[8])
      })).reverse();

      const candles = normalizeCandles(
        rawCandles,
        interval
      );

      if (candles.length > 0) {
        return candles;
      }
    }

  } catch (error) {
    logWarning("OKX SWAP Klines", error);
  }

  // در صورت نبود داده SWAP، Spot امتحان می‌شود.

  const spotInstId =
    base + "-USDT";

  const spotJson = await okxFetch(
    "/api/v5/market/candles",
    {
      instId: spotInstId,
      bar: okxInterval,
      limit: String(barLimit)
    },
    {
      maxAttempts: 3,
      baseDelay: 400
    }
  );

  if (!Array.isArray(spotJson?.data)) {
    throw new Error(
      "OKX klines پاسخ نامعتبر"
    );
  }

  const rawCandles = spotJson.data.map((row) => ({
    time: parseInt(row[0], 10),

    open: parseFloat(row[1]),
    high: parseFloat(row[2]),
    low: parseFloat(row[3]),
    close: parseFloat(row[4]),

    volume: parseFloat(row[5]),
    quoteVolume: parseFloat(row[6]),

    confirm: getConfirmStatus(row[8])
  })).reverse();

  return normalizeCandles(
    rawCandles,
    interval
  );
}

// --------------------------------------------------
// MEXC KLINES
// --------------------------------------------------

async function getKlinesMEXC(
  symbol,
  interval,
  limit
) {
  const base = symbol.replace(/USDT$/, "");

  const mexcSymbol =
    base + "_USDT";

  const mexcInterval =
    CONFIG.MEXC_INTERVAL_MAP[interval];

  if (!mexcInterval) {
    throw new Error(
      "MEXC interval unsupported: " + interval
    );
  }

  const size = Math.max(
    1,
    Math.min(Number(limit) || 300, 1000)
  );

  const json = await mexcFetch(
    "/api/v1/contract/kline/" + mexcSymbol,
    {
      interval: mexcInterval,
      limit: String(size)
    }
  );

  if (!json || !json.data) {
    throw new Error(
      "MEXC klines پاسخ نامعتبر"
    );
  }

  const data = json.data;

  const rawCandles = [];

  const intervalMs =
    INTERVAL_MS[interval] || 3600000;

  const times =
    Array.isArray(data.time) ? data.time : [];

  const opens =
    Array.isArray(data.open) ? data.open : [];

  const highs =
    Array.isArray(data.high) ? data.high : [];

  const lows =
    Array.isArray(data.low) ? data.low : [];

  const closes =
    Array.isArray(data.close) ? data.close : [];

  const volumes =
    Array.isArray(data.vol) ? data.vol : [];

  const now = Date.now();

  for (let i = 0; i < times.length; i++) {
    let openTime = parseInt(times[i], 10);

    if (!Number.isFinite(openTime)) continue;

    // زمان MEXC ممکن است ثانیه یا میلی‌ثانیه باشد.

    if (openTime < 1e12) {
      openTime *= 1000;
    }

    const open = parseFloat(opens[i]);
    const high = parseFloat(highs[i]);
    const low = parseFloat(lows[i]);
    const close = parseFloat(closes[i]);

    const volume = parseFloat(volumes[i]);

    if (!isValidOHLC(open, high, low, close)) {
      continue;
    }

    const closeTime =
      openTime + intervalMs - 1;

    const isClosed = now > closeTime;

    rawCandles.push({
      time: openTime,
      open,
      high,
      low,
      close,
      volume,
      quoteVolume: 0,
      confirm: isClosed ? "1" : "0"
    });
  }

  rawCandles.sort(
    (a, b) => a.time - b.time
  );

  return normalizeCandles(
    rawCandles,
    interval
  );
}

// --------------------------------------------------
// FETCH FROM SPECIFIC EXCHANGE
// --------------------------------------------------

export async function getKlinesFromExchange(
  exchangeKey,
  symbol,
  interval,
  limit
) {
  const aliases = resolveSymbolAliases(symbol);

  let lastError = null;

  for (const alias of aliases) {
    try {
      let candles;

      switch (exchangeKey) {
        case "binance":
          candles = await getKlinesBinance(
            alias,
            interval,
            limit
          );
          break;

        case "okx":
          candles = await getKlinesOKX(
            alias,
            interval,
            limit
          );
          break;

        case "mexc":
          candles = await getKlinesMEXC(
            alias,
            interval,
            limit
          );
          break;

        default:
          throw new Error(
            "Unknown exchange: " + exchangeKey
          );
      }

      if (candles && candles.length > 0) {
        return candles;
      }

    } catch (error) {
      lastError = error;
    }
  }

  throw (
    lastError ||
    new Error(
      `No candles for ${symbol} on ${exchangeKey}`
    )
  );
}

// --------------------------------------------------
// EXCHANGE PRIORITY
// --------------------------------------------------

function getExchangeOrder() {
  const exchanges = CONFIG.EXCHANGES || {};

  return Object.keys(exchanges)
    .filter((key) => exchanges[key]?.enabled)
    .sort((a, b) => {
      const priorityA =
        Number(exchanges[a]?.priority ?? 999);

      const priorityB =
        Number(exchanges[b]?.priority ?? 999);

      return priorityA - priorityB;
    });
}

// --------------------------------------------------
// MAIN KLINES
// --------------------------------------------------

export async function getKlines(
  symbol,
  interval,
  limit = CONFIG.KLINE_LIMIT
) {
  const safeLimit = Math.max(
    1,
    Math.min(Number(limit) || CONFIG.KLINE_LIMIT, 1000)
  );

  const cacheKey =
    `${symbol}:${interval}:${safeLimit}`;

  const cached = klineCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.time <
      CACHE_TTL.KLINES * 1000
  ) {
    return cached.candles;
  }

  const exchanges = getExchangeOrder();

  if (exchanges.length === 0) {
    throw new Error(
      "هیچ صرافی فعالی در CONFIG.EXCHANGES وجود ندارد"
    );
  }

  const minCandles = Math.max(
    1,
    Number(CONFIG.MIN_CANDLES) || 100
  );

  const errors = [];

  // اجرای ترتیبی بر اساس اولویت صرافی‌ها

  for (const exchangeKey of exchanges) {
    try {
      const candles = await getKlinesFromExchange(
        exchangeKey,
        symbol,
        interval,
        safeLimit
      );

      const closedCandles = candles.filter(
        (candle) => !candle.incomplete
      );

      if (closedCandles.length < minCandles) {
        throw new Error(
          `Not enough closed candles from ${exchangeKey}: ${closedCandles.length}`
        );
      }

      const result = candles.slice(-safeLimit);

      klineCache.set(cacheKey, {
        time: Date.now(),
        candles: result,
        exchange: exchangeKey
      });

      return result;

    } catch (error) {
      errors.push({
        exchange: exchangeKey,
        error
      });

      logWarning(
        `${exchangeKey} Klines`,
        error
      );
    }
  }

  const details = errors
    .map((item) =>
      `${item.exchange}: ${item.error?.message || "unknown"}`
    )
    .join(" | ");

  throw new Error(
    `هیچ صرافی داده کندل معتبر برنگرداند. ${details}`
  );
}

// --------------------------------------------------
// MARKET SNAPSHOT
// --------------------------------------------------

export async function getMarketSnapshot(
  symbol,
  timeframe
) {
  const snapshotKey =
    `${symbol}:${timeframe}`;

  const cached = snapshotCache.get(snapshotKey);

  if (
    cached &&
    Date.now() - cached.time <
      CACHE_TTL.SNAPSHOT * 1000
  ) {
    return cached.snapshot;
  }

  const current = await getKlines(
    symbol,
    timeframe
  );

  const snapshot = {
    current,
    timeframe
  };

  snapshotCache.set(snapshotKey, {
    time: Date.now(),
    snapshot
  });

  return snapshot;
}
