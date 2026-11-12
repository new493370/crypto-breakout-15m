
import { CONFIG, INTERVAL_MS } from "./config.js";

const CACHE_TTL = {
  SYMBOLS: CONFIG.SYMBOL_CACHE_SECONDS,
  TICKERS: 300,
  KLINES: CONFIG.KLINE_CACHE_SECONDS,
  SNAPSHOT: 60
};

let symbolCache = { timestamp: 0, symbols: [] };
let tickersCache = { timestamp: 0, data: [] };

const klineCache = new Map();
const snapshotCache = new Map();
const pendingRequests = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .toUpperCase()
    .replace(/[-_/:\s]/g, "");
}

function parseNumber(value) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function isValidCandle(candle) {
  if (!candle || typeof candle !== "object") return false;

  const values = [
    candle.time,
    candle.open,
    candle.high,
    candle.low,
    candle.close
  ];

  if (!values.every(Number.isFinite)) return false;

  return (
    candle.time > 0 &&
    candle.open > 0 &&
    candle.high > 0 &&
    candle.low > 0 &&
    candle.close > 0 &&
    candle.high >= candle.low &&
    candle.high >= Math.max(candle.open, candle.close) &&
    candle.low <= Math.min(candle.open, candle.close)
  );
}

function isClosedCandle(value) {
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    value === "true"
  );
}

function isIncompleteCandle(value) {
  return (
    value === false ||
    value === 0 ||
    value === "0" ||
    value === "false"
  );
}

function getCache(cache, key, ttl) {
  const cached = cache.get(key);

  if (!cached) return null;

  if (Date.now() - cached.time >= ttl * 1000) {
    cache.delete(key);
    return null;
  }

  return cached.data;
}

function setCache(cache, key, data) {
  cache.set(key, {
    time: Date.now(),
    data
  });

  if (cache.size > 2000) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }

  return data;
}

function deduplicateRequest(key, request) {
  if (pendingRequests.has(key)) {
    return pendingRequests.get(key);
  }

  const promise = Promise.resolve()
    .then(request)
    .finally(() => {
      pendingRequests.delete(key);
    });

  pendingRequests.set(key, promise);

  return promise;
}

async function genericFetch(baseUrl, path, params = {}, options = {}) {
  const url = new URL(baseUrl + path);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const maxAttempts = Number.isInteger(options.maxAttempts)
    ? Math.max(1, options.maxAttempts)
    : 3;

  const baseDelay = Number.isFinite(options.baseDelay)
    ? Math.max(0, options.baseDelay)
    : 400;

  const timeoutMs = Number.isFinite(options.timeout)
    ? Math.max(1, options.timeout)
    : CONFIG.MARKET_TIMEOUT;

  const label = options.label || "HTTP";

  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs
    );

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
        lastError = new Error(label + " HTTP 429");

        const retryAfter = parseNumber(
          response.headers.get("Retry-After")
        );

        const delay = retryAfter > 0
          ? Math.min(retryAfter * 1000, 15000)
          : baseDelay * (attempt + 1);

        if (attempt < maxAttempts - 1) {
          await sleep(delay);
        }

        continue;
      }

      if (response.status === 418) {
        lastError = new Error(label + " IP banned (418)");

        if (attempt < maxAttempts - 1) {
          await sleep(
            Math.min(5000 * (attempt + 1), 30000)
          );
        }

        continue;
      }

      if (!response.ok) {
        const error = new Error(
          label + " HTTP " + response.status
        );

        error.status = response.status;

        if (
          response.status < 500 ||
          attempt === maxAttempts - 1
        ) {
          throw error;
        }

        lastError = error;

        await sleep(baseDelay * (attempt + 1));
        continue;
      }

      return await response.json();
    } catch (error) {
      lastError = error;

      const status = error?.status || 0;

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

  throw lastError || new Error(label + " خطای ناشناخته");
}

export function okxFetch(path, params = {}, options = {}) {
  return genericFetch(CONFIG.OKX_BASE_URL, path, params, {
    ...options,
    label: "OKX"
  }).then((json) => {
    if (!json || String(json.code) !== "0") {
      throw new Error(
        "OKX error: " + (json?.msg || json?.code || "unknown")
      );
    }

    return json;
  });
}

export function binanceFetch(path, params = {}, options = {}) {
  return genericFetch(
    CONFIG.BINANCE_FUTURES_URL,
    path,
    params,
    {
      ...options,
      label: "Binance Futures"
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
  return genericFetch(CONFIG.MEXC_BASE_URL, path, params, {
    ...options,
    label: "MEXC"
  }).then((json) => {
    if (
      json &&
      json.code !== undefined &&
      ![0, "0", 200, "200"].includes(json.code)
    ) {
      throw new Error(
        "MEXC error: " + (json.message || json.code || "unknown")
      );
    }

    return json;
  });
}

export function resolveSymbolAliases(symbol) {
  const normalized = normalizeSymbol(symbol);

  const aliases = CONFIG.SYMBOL_ALIASES?.[normalized];

  if (Array.isArray(aliases) && aliases.length > 0) {
    return [
      ...new Set([
        normalized,
        ...aliases.map(normalizeSymbol).filter(Boolean)
      ])
    ];
  }

  return normalized ? [normalized] : [];
}

function isAllowedBaseAsset(base) {
  if (!base) return false;

  if (CONFIG.EXCLUDED_BASE_ASSETS.includes(base)) {
    return false;
  }

  if (/^X[A-Z]{4,}$/.test(base)) return false;
  if (base.includes("TEST")) return false;

  return true;
}

function getExchangeOrder() {
  return Object.keys(CONFIG.EXCHANGES)
    .filter((key) => CONFIG.EXCHANGES[key]?.enabled === true)
    .sort((a, b) => {
      return (
        CONFIG.EXCHANGES[a].priority -
        CONFIG.EXCHANGES[b].priority
      );
    });
}

function getExchangeLimit(exchangeKey, requestedLimit) {
  const exchangeConfig = CONFIG.EXCHANGES[exchangeKey];

  const requested = Number.isFinite(requestedLimit)
    ? Math.floor(requestedLimit)
    : CONFIG.KLINE_LIMIT;

  const maximum = Number.isFinite(exchangeConfig?.maxCandles)
    ? exchangeConfig.maxCandles
    : requested;

  return Math.max(1, Math.min(requested, maximum));
}

export async function getExchangeSymbols(force = false) {
  const now = Date.now() / 1000;

  if (
    !force &&
    symbolCache.symbols.length > 0 &&
    now - symbolCache.timestamp < CACHE_TTL.SYMBOLS
  ) {
    return symbolCache.symbols;
  }

  return deduplicateRequest("exchange-symbols", async () => {
    const allSymbols = new Map();
    const exchanges = getExchangeOrder();

    for (const exchangeKey of exchanges) {
      try {
        if (exchangeKey === "binance") {
          const json = await binanceFetch(
            "/fapi/v1/exchangeInfo"
          );

          if (!Array.isArray(json?.symbols)) continue;

          for (const item of json.symbols) {
            if (item.status !== "TRADING") continue;
            if (item.quoteAsset !== "USDT") continue;

            if (
              item.contractType &&
              item.contractType !== "PERPETUAL"
            ) {
              continue;
            }

            const base = String(
              item.baseAsset || ""
            ).toUpperCase();

            if (!isAllowedBaseAsset(base)) continue;

            const symbol = base + "USDT";

            if (!allSymbols.has(symbol)) {
              allSymbols.set(symbol, {
                symbol,
                base,
                quote: "USDT",
                exchange: "binance"
              });
            }
          }
        }

        if (exchangeKey === "okx") {
          const json = await okxFetch(
            "/api/v5/public/instruments",
            {
              instType: "SWAP"
            }
          );

          if (!Array.isArray(json?.data)) continue;

          for (const item of json.data) {
            if (item.state !== "live") continue;
            if (item.settleCcy !== "USDT") continue;

            const instId = String(item.instId || "");

            if (!instId.endsWith("-USDT-SWAP")) continue;

            const base = String(
              item.baseCcy || instId.split("-")[0] || ""
            ).toUpperCase();

            if (!isAllowedBaseAsset(base)) continue;

            const symbol = base + "USDT";

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

        if (exchangeKey === "mexc") {
          const json = await mexcFetch(
            "/api/v1/contract/detail"
          );

          if (!Array.isArray(json?.data)) continue;

          for (const item of json.data) {
            if (Number(item.state) !== 0) continue;
            if (item.quoteCoin !== "USDT") continue;

            const base = String(
              item.baseCoin || ""
            ).toUpperCase();

            if (!isAllowedBaseAsset(base)) continue;

            const symbol = base + "USDT";

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
        continue;
      }
    }

    const result = Array.from(allSymbols.values());

    result.sort((a, b) => a.symbol.localeCompare(b.symbol));

    symbolCache = {
      timestamp: Date.now() / 1000,
      symbols: result
    };

    return result;
  });
}

export async function getTickers(force = false) {
  const now = Date.now() / 1000;

  if (
    !force &&
    tickersCache.data.length > 0 &&
    now - tickersCache.timestamp < CACHE_TTL.TICKERS
  ) {
    return tickersCache.data;
  }

  return deduplicateRequest("exchange-tickers", async () => {
    const validSymbols = await getExchangeSymbols();
    const validSet = new Set(
      validSymbols.map((item) => item.symbol)
    );

    const result = [];
    const seen = new Set();
    const exchanges = getExchangeOrder();

    for (const exchangeKey of exchanges) {
      try {
        if (exchangeKey === "binance") {
          const json = await binanceFetch(
            "/fapi/v1/ticker/24hr"
          );

          if (!Array.isArray(json)) continue;

          for (const item of json) {
            const raw = normalizeSymbol(item.symbol);

            if (!raw.endsWith("USDT")) continue;

            const base = raw.slice(0, -4);
            const symbol = base + "USDT";

            if (!isAllowedBaseAsset(base)) continue;
            if (!validSet.has(symbol) || seen.has(symbol)) continue;

            const last = parseNumber(item.lastPrice);
            const open24h = parseNumber(item.openPrice);
            const quoteVolume = parseNumber(item.quoteVolume);

            if (last <= 0 || quoteVolume <= 0) continue;

            const changePercent = open24h > 0
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

        if (exchangeKey === "okx") {
          const json = await okxFetch(
            "/api/v5/market/tickers",
            {
              instType: "SWAP"
            }
          );

          if (!Array.isArray(json?.data)) continue;

          for (const item of json.data) {
            const instId = String(item.instId || "");

            if (!instId.endsWith("-USDT-SWAP")) continue;

            const base = String(
              instId.split("-")[0] || ""
            ).toUpperCase();

            const symbol = base + "USDT";

            if (!isAllowedBaseAsset(base)) continue;
            if (!validSet.has(symbol) || seen.has(symbol)) continue;

            const last = parseNumber(item.last);
            const open24h = parseNumber(item.open24h);
            const quoteVolume = parseNumber(item.volCcy24h);

            if (last <= 0 || quoteVolume <= 0) continue;

            const changePercent = open24h > 0
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

        if (exchangeKey === "mexc") {
          const json = await mexcFetch(
            "/api/v1/contract/ticker"
          );

          if (!Array.isArray(json?.data)) continue;

          for (const item of json.data) {
            const raw = normalizeSymbol(item.symbol);

            if (!raw.endsWith("USDT")) continue;

            const base = raw.slice(0, -4);
            const symbol = base + "USDT";

            if (!isAllowedBaseAsset(base)) continue;
            if (!validSet.has(symbol) || seen.has(symbol)) continue;

            const last = parseNumber(item.lastPrice);
            const quoteVolume = parseNumber(item.amount24);
            const riseFallRate = parseNumber(item.riseFallRate);

            if (last <= 0 || quoteVolume <= 0) continue;

            result.push({
              symbol,
              base,
              quote: "USDT",
              price: last,
              change: riseFallRate * 100,
              quote_volume: quoteVolume
            });

            seen.add(symbol);
          }
        }
      } catch (error) {
        continue;
      }
    }

    result.sort((a, b) => b.quote_volume - a.quote_volume);

    tickersCache = {
      timestamp: Date.now() / 1000,
      data: result
    };

    return result;
  });
}

export async function getTopSymbols(limit = CONFIG.MARKET_TOP_LIMIT) {
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

  ranked.sort((a, b) => b.quote_volume - a.quote_volume);

  const safeLimit = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : CONFIG.MARKET_TOP_LIMIT;

  return ranked.slice(0, Math.min(safeLimit, 1000));
}

export function normalizeCandles(rawCandles, interval) {
  if (!Array.isArray(rawCandles)) return [];

  const intervalMs = INTERVAL_MS[interval] || 0;
  const now = Date.now();

  const normalized = [];
  const incompleteCandles = [];

  for (const raw of rawCandles) {
    if (!raw || typeof raw !== "object") continue;

    const openTime = parseNumber(raw.time);

    const candleObj = {
      time: openTime,
      open_time: openTime,
      close_time: intervalMs > 0
        ? openTime + intervalMs - 1
        : openTime,
      open: parseNumber(raw.open),
      high: parseNumber(raw.high),
      low: parseNumber(raw.low),
      close: parseNumber(raw.close),
      volume: parseNumber(raw.volume),
      quote_volume: parseNumber(raw.quoteVolume),
      trades: 0,
      incomplete: isIncompleteCandle(raw.confirm)
    };

    if (!isValidCandle(candleObj)) continue;

    if (candleObj.incomplete) {
      incompleteCandles.push(candleObj);
    } else {
      normalized.push(candleObj);
    }
  }

  normalized.sort((a, b) => a.time - b.time);
  incompleteCandles.sort((a, b) => a.time - b.time);

  if (incompleteCandles.length > 0) {
    const openCandle = incompleteCandles[
      incompleteCandles.length - 1
    ];

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

  const unique = [];
  const seen = new Set();

  for (const candle of normalized) {
    if (seen.has(candle.time)) continue;

    seen.add(candle.time);
    unique.push(candle);
  }

  unique.sort((a, b) => a.time - b.time);

  return unique;
}

async function getKlinesBinance(symbol, interval, limit) {
  const binanceSymbol = normalizeSymbol(symbol);
  const binanceInterval = CONFIG.BINANCE_INTERVAL_MAP[interval];

  if (!binanceInterval) {
    throw new Error("Binance interval unsupported: " + interval);
  }

  const size = Math.min(
    Math.max(1, Math.floor(limit)),
    1000
  );

  const json = await binanceFetch(
    "/fapi/v1/klines",
    {
      symbol: binanceSymbol,
      interval: binanceInterval,
      limit: String(size)
    }
  );

  if (!Array.isArray(json)) {
    throw new Error("Binance Futures klines پاسخ نامعتبر");
  }

  const rawCandles = [];
  const intervalMs = INTERVAL_MS[interval] || 3600000;

  for (const row of json) {
    if (!Array.isArray(row) || row.length < 6) continue;

    const openTime = parseNumber(row[0]);
    const open = parseNumber(row[1]);
    const high = parseNumber(row[2]);
    const low = parseNumber(row[3]);
    const close = parseNumber(row[4]);
    const volume = parseNumber(row[5]);
    const turnover = parseNumber(row[7]);

    const closeTime = openTime + intervalMs - 1;
    const isClosed = Date.now() > closeTime;

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

  rawCandles.sort((a, b) => a.time - b.time);

  return normalizeCandles(rawCandles, interval);
}

async function getKlinesOKX(symbol, interval, limit) {
  const base = normalizeSymbol(symbol).replace(/USDT$/, "");
  const okxInterval = CONFIG.OKX_INTERVAL_MAP[interval];

  if (!okxInterval) {
    throw new Error("OKX interval unsupported: " + interval);
  }

  const barLimit = Math.min(
    Math.max(1, Math.floor(limit)),
    300
  );

  const instId = base + "-USDT-SWAP";

  const json = await okxFetch(
    "/api/v5/market/candles",
    {
      instId,
      bar: okxInterval,
      limit: String(barLimit)
    }
  );

  if (!Array.isArray(json?.data) || json.data.length === 0) {
    throw new Error("OKX Swap klines خالی یا نامعتبر است");
  }

  const rawCandles = json.data.map((row) => ({
    time: parseNumber(row[0]),
    open: parseNumber(row[1]),
    high: parseNumber(row[2]),
    low: parseNumber(row[3]),
    close: parseNumber(row[4]),
    volume: parseNumber(row[5]),
    quoteVolume: parseNumber(row[7]),
    confirm: row[8] ?? "1"
  })).reverse();

  return normalizeCandles(rawCandles, interval);
}

async function getKlinesMEXC(symbol, interval, limit) {
  const base = normalizeSymbol(symbol).replace(/USDT$/, "");
  const mexcSymbol = base + "_USDT";
  const mexcInterval = CONFIG.MEXC_INTERVAL_MAP[interval];

  if (!mexcInterval) {
    throw new Error("MEXC interval unsupported: " + interval);
  }

  const size = Math.min(
    Math.max(1, Math.floor(limit)),
    1000
  );

  const json = await mexcFetch(
    "/api/v1/contract/kline/" + mexcSymbol,
    {
      interval: mexcInterval,
      limit: String(size)
    }
  );

  if (!json || !json.data) {
    throw new Error("MEXC klines پاسخ نامعتبر");
  }

  const data = json.data;
  const rawCandles = [];

  const intervalMs = INTERVAL_MS[interval] || 3600000;

  const times = Array.isArray(data.time) ? data.time : [];
  const opens = Array.isArray(data.open) ? data.open : [];
  const highs = Array.isArray(data.high) ? data.high : [];
  const lows = Array.isArray(data.low) ? data.low : [];
  const closes = Array.isArray(data.close) ? data.close : [];
  const volumes = Array.isArray(data.vol) ? data.vol : [];
  const amounts = Array.isArray(data.amount) ? data.amount : [];

  for (let i = 0; i < times.length; i++) {
    const openTime = parseNumber(times[i]) * 1000;

    const open = parseNumber(opens[i]);
    const high = parseNumber(highs[i]);
    const low = parseNumber(lows[i]);
    const close = parseNumber(closes[i]);
    const volume = parseNumber(volumes[i]);
    const quoteVolume = parseNumber(amounts[i]);

    const closeTime = openTime + intervalMs - 1;
    const isClosed = Date.now() > closeTime;

    rawCandles.push({
      time: openTime,
      open,
      high,
      low,
      close,
      volume,
      quoteVolume,
      confirm: isClosed ? "1" : "0"
    });
  }

  rawCandles.sort((a, b) => a.time - b.time);

  return normalizeCandles(rawCandles, interval);
}

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
          throw new Error("Unknown exchange: " + exchangeKey);
      }

      if (Array.isArray(candles) && candles.length > 0) {
        return candles;
      }

      lastError = new Error(
        "No candles for " + alias + " on " + exchangeKey
      );
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(
    "No candles for " + symbol + " on " + exchangeKey
  );
}

export async function getKlines(
  symbol,
  interval,
  limit = CONFIG.KLINE_LIMIT
) {
  const normalizedSymbol = normalizeSymbol(symbol);

  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.floor(limit))
    : CONFIG.KLINE_LIMIT;

  const cacheKey =
    normalizedSymbol + ":" + interval + ":" + safeLimit;

  const cached = getCache(
    klineCache,
    cacheKey,
    CACHE_TTL.KLINES
  );

  if (cached) return cached;

  return deduplicateRequest("klines:" + cacheKey, async () => {
    const exchanges = getExchangeOrder();

    const minimumCandles = Math.max(
      1,
      CONFIG.MIN_CANDLES || 100
    );

    let lastError = null;

    for (const exchangeKey of exchanges) {
      try {
        const exchangeLimit = getExchangeLimit(
          exchangeKey,
          safeLimit
        );

        const candles = await getKlinesFromExchange(
          exchangeKey,
          normalizedSymbol,
          interval,
          exchangeLimit
        );

        if (!Array.isArray(candles)) {
          throw new Error("Invalid candles response");
        }

        const closedCandles = candles.filter(
          (candle) => !candle.incomplete
        );

        if (closedCandles.length < minimumCandles) {
          throw new Error(
            "Not enough closed candles (" +
            closedCandles.length +
            "/" +
            minimumCandles +
            ")"
          );
        }

        setCache(klineCache, cacheKey, candles);

        return candles;
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(
      "هیچ صرافی داده معتبر و کافی برای " +
      normalizedSymbol +
      " برنگرداند" +
      (lastError?.message ? ": " + lastError.message : "")
    );
  });
}

export async function getMarketSnapshot(symbol, timeframe) {
  const normalizedSymbol = normalizeSymbol(symbol);

  const snapshotKey =
    normalizedSymbol + ":" + timeframe;

  const cached = getCache(
    snapshotCache,
    snapshotKey,
    CACHE_TTL.SNAPSHOT
  );

  if (cached) return cached;

  return deduplicateRequest(
    "snapshot:" + snapshotKey,
    async () => {
      const current = await getKlines(
        normalizedSymbol,
        timeframe
      );

      const snapshot = {
        current,
        timeframe
      };

      setCache(snapshotCache, snapshotKey, snapshot);

      return snapshot;
    }
  );
}
