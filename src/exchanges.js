import { CONFIG, INTERVAL_MS } from "./config.js";

const CACHE_TTL = {
  SYMBOLS: CONFIG.SYMBOL_CACHE_SECONDS,
  TICKERS: 300,
  KLINES: CONFIG.KLINE_CACHE_SECONDS,
  SNAPSHOT: 60
};

let symbolCache = { timestamp: 0, symbols: [] };
let tickersCache = { timestamp: 0, data: [] };
const klineCache = {};
const snapshotCache = {};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSymbol(symbol) {
  return String(symbol || "").toUpperCase().replace(/[-_/:\s]/g, "");
}

function parseNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function isValidCandle(candle) {
  return (
    Number.isFinite(candle.time) &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close) &&
    candle.open > 0 &&
    candle.high > 0 &&
    candle.low > 0 &&
    candle.close > 0 &&
    candle.high >= candle.low &&
    candle.high >= Math.max(candle.open, candle.close) &&
    candle.low <= Math.min(candle.open, candle.close)
  );
}

async function genericFetch(baseUrl, path, params = {}, options = {}) {
  const url = new URL(baseUrl + path);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const maxAttempts = options.maxAttempts || 3;
  const baseDelay = options.baseDelay || 400;
  const timeoutMs = options.timeout || CONFIG.MARKET_TIMEOUT;
  const label = options.label || "HTTP";

  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
        redirect: "follow"
      });

      if (response.status === 429) {
        lastError = new Error(label + " HTTP 429");

        const retryAfter = parseFloat(response.headers.get("Retry-After"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 15000)
          : baseDelay * (attempt + 1);

        if (attempt < maxAttempts - 1) await sleep(delay);
        continue;
      }

      if (response.status === 418) {
        lastError = new Error(label + " IP banned (418)");

        if (attempt < maxAttempts - 1) {
          await sleep(Math.min(5000 * (attempt + 1), 30000));
        }

        continue;
      }

      if (!response.ok) {
        const error = new Error(label + " HTTP " + response.status);
        error.status = response.status;

        if (response.status < 500 || attempt === maxAttempts - 1) {
          throw error;
        }

        lastError = error;
        await sleep(baseDelay * (attempt + 1));
        continue;
      }

      return await response.json();
    } catch (e) {
      lastError = e;

      const status = e?.status || 0;
      const retryable =
        status === 429 ||
        status === 418 ||
        status >= 500 ||
        status === 0 ||
        e?.name === "AbortError";

      if (!retryable || attempt === maxAttempts - 1) break;

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
    if (!json || json.code !== "0") {
      throw new Error("OKX error: " + (json?.msg || json?.code || "unknown"));
    }

    return json;
  });
}

export function binanceFetch(path, params = {}, options = {}) {
  return genericFetch(CONFIG.BINANCE_SPOT_URL, path, params, {
    ...options,
    label: "Binance"
  });
}

export function binanceSpotFetch(path, params = {}, options = {}) {
  return genericFetch(CONFIG.BINANCE_SPOT_URL, path, params, {
    ...options,
    label: "BinanceSpot"
  });
}

export function mexcFetch(path, params = {}, options = {}) {
  return genericFetch(CONFIG.MEXC_BASE_URL, path, params, {
    ...options,
    label: "MEXC"
  }).then((json) => {
    if (
      json &&
      json.code !== undefined &&
      json.code !== 0 &&
      json.code !== "0" &&
      json.code !== 200
    ) {
      throw new Error("MEXC error: " + (json.message || json.code || "unknown"));
    }

    return json;
  });
}

export function resolveSymbolAliases(symbol) {
  const normalized = normalizeSymbol(symbol);
  const aliases = CONFIG.SYMBOL_ALIASES[normalized];

  if (Array.isArray(aliases) && aliases.length > 0) {
    return [...new Set([normalized, ...aliases.map(normalizeSymbol)])];
  }

  return [normalized];
}

function isAllowedBaseAsset(base) {
  if (!base) return false;
  if (CONFIG.EXCLUDED_BASE_ASSETS.includes(base)) return false;
  if (/^X[A-Z]{4,}$/.test(base)) return false;
  if (base.includes("TEST")) return false;

  return true;
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

  const allSymbols = new Map();

  try {
    const binanceJson = await binanceFetch("/api/v3/exchangeInfo");

    if (Array.isArray(binanceJson?.symbols)) {
      for (const item of binanceJson.symbols) {
        if (item.status !== "TRADING") continue;
        if (item.quoteAsset !== "USDT") continue;

        const base = String(item.baseAsset || "").toUpperCase();

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
  } catch (e) {}

  try {
    const okxJson = await okxFetch("/api/v5/public/instruments", {
      instType: "SWAP"
    });

    if (Array.isArray(okxJson?.data)) {
      for (const item of okxJson.data) {
        if (item.state !== "live") continue;
        if (item.settleCcy !== "USDT") continue;
        if (!String(item.instId || "").endsWith("-USDT-SWAP")) continue;

        const base = String(item.ctValCcy || item.baseCcy || "").toUpperCase();

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
  } catch (e) {}

  try {
    const mexcJson = await mexcFetch("/api/v1/contract/detail");

    if (Array.isArray(mexcJson?.data)) {
      for (const item of mexcJson.data) {
        if (item.state !== 0) continue;
        if (item.quoteCoin !== "USDT") continue;

        const base = String(item.baseCoin || "").toUpperCase();

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
  } catch (e) {}

  const result = Array.from(allSymbols.values());

  result.sort((a, b) => a.symbol.localeCompare(b.symbol));

  symbolCache.symbols = result;
  symbolCache.timestamp = now;

  return result;
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

  const validSymbols = await getExchangeSymbols();
  const validSet = new Set(validSymbols.map((s) => s.symbol));
  const result = [];
  const seen = new Set();

  try {
    const binanceJson = await binanceFetch("/api/v3/ticker/24hr");

    if (Array.isArray(binanceJson)) {
      for (const item of binanceJson) {
        const raw = normalizeSymbol(item.symbol);

        if (!raw.endsWith("USDT")) continue;

        const base = raw.slice(0, -4);
        const symbol = base + "USDT";

        if (!isAllowedBaseAsset(base)) continue;
        if (!validSet.has(symbol) || seen.has(symbol)) continue;

        const last = parseNumber(item.lastPrice);
        const open24h = parseNumber(item.openPrice);
        const quoteVolume = parseNumber(item.quoteVolume);

        if (last <= 0 || quoteVolume < 0) continue;

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
  } catch (e) {}

  try {
    const okxJson = await okxFetch("/api/v5/market/tickers", {
      instType: "SWAP"
    });

    if (Array.isArray(okxJson?.data)) {
      for (const item of okxJson.data) {
        if (!String(item.instId || "").endsWith("-USDT-SWAP")) continue;

        const base = String(item.instId.split("-")[0] || "").toUpperCase();
        const symbol = base + "USDT";

        if (!isAllowedBaseAsset(base)) continue;
        if (!validSet.has(symbol) || seen.has(symbol)) continue;

        const last = parseNumber(item.last);
        const open24h = parseNumber(item.open24h);
        const volCcy24h = parseNumber(item.volCcy24h);
        const vol24h = parseNumber(item.vol24h);

        if (last <= 0) continue;

        const quoteVolume = volCcy24h > 0
          ? volCcy24h
          : vol24h > 0
            ? vol24h * last
            : 0;

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
  } catch (e) {}

  try {
    const mexcJson = await mexcFetch("/api/v1/contract/ticker");

    if (Array.isArray(mexcJson?.data)) {
      for (const item of mexcJson.data) {
        const raw = normalizeSymbol(item.symbol);

        if (!raw.endsWith("USDT")) continue;

        const base = raw.slice(0, -4);
        const symbol = base + "USDT";

        if (!isAllowedBaseAsset(base)) continue;
        if (!validSet.has(symbol) || seen.has(symbol)) continue;

        const last = parseNumber(item.lastPrice);
        const quoteVolume = parseNumber(item.amount24 || item.volume24);
        const riseFallRate = parseNumber(item.riseFallRate);

        if (last <= 0) continue;

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
  } catch (e) {}

  result.sort((a, b) => b.quote_volume - a.quote_volume);

  tickersCache.data = result;
  tickersCache.timestamp = now;

  return result;
}

export async function getTopSymbols(limit = CONFIG.MARKET_TOP_LIMIT) {
  const symbols = await getExchangeSymbols();
  const tickers = await getTickers();

  const allowed = new Set(symbols.map((s) => s.symbol));
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

  return ranked.slice(0, Math.min(limit, 1000));
}

export function normalizeCandles(rawCandles, interval) {
  const intervalMs = INTERVAL_MS[interval] || 0;
  const now = Date.now();
  const normalized = [];
  const incompleteCandles = [];

  for (const raw of rawCandles) {
    const openTime = raw.time;

    const candleObj = {
      time: openTime,
      open_time: openTime,
      close_time: intervalMs > 0 ? openTime + intervalMs - 1 : openTime,
      open: raw.open,
      high: raw.high,
      low: raw.low,
      close: raw.close,
      volume: Number.isFinite(raw.volume) ? raw.volume : 0,
      quote_volume: Number.isFinite(raw.quoteVolume) ? raw.quoteVolume : 0,
      trades: 0,
      incomplete: raw.confirm === "0"
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
    const openCandle = incompleteCandles[incompleteCandles.length - 1];

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

  const size = Math.min(limit, 1000);

  const json = await binanceSpotFetch("/api/v3/klines", {
    symbol: binanceSymbol,
    interval: binanceInterval,
    limit: String(size)
  });

  if (!Array.isArray(json)) {
    throw new Error("Binance klines پاسخ نامعتبر");
  }

  const rawCandles = [];
  const intervalMs = INTERVAL_MS[interval] || 3600000;

  for (const row of json) {
    if (!Array.isArray(row) || row.length < 6) continue;

    const openTime = parseInt(row[0], 10);
    const open = parseFloat(row[1]);
    const high = parseFloat(row[2]);
    const low = parseFloat(row[3]);
    const close = parseFloat(row[4]);
    const volume = parseFloat(row[5]);
    const turnover = parseFloat(row[7] || "0");

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

  const barLimit = Math.min(limit, 300);
  const swapInstId = base + "-USDT-SWAP";

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

  if (Array.isArray(swapJson.data) && swapJson.data.length > 0) {
    const rawCandles = swapJson.data.map((row) => ({
      time: parseInt(row[0], 10),
      open: parseFloat(row[1]),
      high: parseFloat(row[2]),
      low: parseFloat(row[3]),
      close: parseFloat(row[4]),
      volume: parseFloat(row[5]),
      quoteVolume: parseFloat(row[6]),
      confirm: String(row[8] ?? "1")
    })).reverse();

    const candles = normalizeCandles(rawCandles, interval);

    if (candles.length > 0) return candles;
  }

  const spotInstId = base + "-USDT";

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

  if (!Array.isArray(spotJson.data)) {
    throw new Error("OKX klines پاسخ نامعتبر");
  }

  const rawCandles = spotJson.data.map((row) => ({
    time: parseInt(row[0], 10),
    open: parseFloat(row[1]),
    high: parseFloat(row[2]),
    low: parseFloat(row[3]),
    close: parseFloat(row[4]),
    volume: parseFloat(row[5]),
    quoteVolume: parseFloat(row[6]),
    confirm: String(row[8] ?? "1")
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

  const size = Math.min(limit, 1000);

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

  for (let i = 0; i < times.length; i++) {
    const openTime = parseInt(times[i], 10) * 1000;
    const open = parseFloat(opens[i]);
    const high = parseFloat(highs[i]);
    const low = parseFloat(lows[i]);
    const close = parseFloat(closes[i]);
    const volume = parseFloat(volumes[i]);

    const closeTime = openTime + intervalMs - 1;
    const isClosed = Date.now() > closeTime;

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

  rawCandles.sort((a, b) => a.time - b.time);

  return normalizeCandles(rawCandles, interval);
}

export async function getKlinesFromExchange(exchangeKey, symbol, interval, limit) {
  const aliases = resolveSymbolAliases(symbol);
  let lastError = null;

  for (const alias of aliases) {
    try {
      let candles;

      switch (exchangeKey) {
        case "binance":
          candles = await getKlinesBinance(alias, interval, limit);
          break;

        case "okx":
          candles = await getKlinesOKX(alias, interval, limit);
          break;

        case "mexc":
          candles = await getKlinesMEXC(alias, interval, limit);
          break;

        default:
          throw new Error("Unknown exchange: " + exchangeKey);
      }

      if (Array.isArray(candles) && candles.length > 0) {
        return candles;
      }
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error("No candles for " + symbol + " on " + exchangeKey);
}

function getExchangeOrder() {
  return Object.keys(CONFIG.EXCHANGES)
    .filter((key) => CONFIG.EXCHANGES[key].enabled)
    .sort((a, b) => {
      return CONFIG.EXCHANGES[a].priority - CONFIG.EXCHANGES[b].priority;
    });
}

export async function getKlines(symbol, interval, limit = CONFIG.KLINE_LIMIT) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const cacheKey = normalizedSymbol + ":" + interval + ":" + limit;

  const cached = klineCache[cacheKey];

  if (
    cached &&
    Date.now() - cached.time < CACHE_TTL.KLINES * 1000
  ) {
    return cached.candles;
  }

  const exchanges = getExchangeOrder();
  const minimumCandles = Math.max(1, CONFIG.MIN_CANDLES || 100);
  let lastError = null;

  for (const exchangeKey of exchanges) {
    try {
      const candles = await getKlinesFromExchange(
        exchangeKey,
        normalizedSymbol,
        interval,
        limit
      );

      if (!Array.isArray(candles)) {
        throw new Error("Invalid candles response");
      }

      const closedCandles = candles.filter((candle) => !candle.incomplete);

      if (closedCandles.length < minimumCandles) {
        throw new Error(
          "Not enough closed candles (" +
          closedCandles.length +
          "/" +
          minimumCandles +
          ")"
        );
      }

      klineCache[cacheKey] = {
        time: Date.now(),
        candles
      };

      return candles;
    } catch (e) {
      lastError = e;
    }
  }

  throw new Error(
    "هیچ صرافی داده معتبر و کافی برای " +
    normalizedSymbol +
    " برنگرداند" +
    (lastError?.message ? ": " + lastError.message : "")
  );
}

export async function getMarketSnapshot(symbol, timeframe) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const snapshotKey = normalizedSymbol + ":" + timeframe;

  const cached = snapshotCache[snapshotKey];

  if (
    cached &&
    Date.now() - cached.time < CACHE_TTL.SNAPSHOT * 1000
  ) {
    return cached.snapshot;
  }

  const current = await getKlines(normalizedSymbol, timeframe);

  const snapshot = {
    current,
    timeframe
  };

  snapshotCache[snapshotKey] = {
    time: Date.now(),
    snapshot
  };

  return snapshot;
}
