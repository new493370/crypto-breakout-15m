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

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function genericFetch(baseUrl, path, params = {}, options = {}) {
  const url = new URL(baseUrl + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

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
        const retryAfter = response.headers.get("Retry-After");
        const retrySeconds = parseFloat(retryAfter);
        if (Number.isFinite(retrySeconds) && retrySeconds > 0) {
          await sleep(Math.min(retrySeconds * 1000, 15000));
        } else {
          await sleep(baseDelay * (attempt + 1));
        }
        continue;
      }

      if (response.status === 418) {
        lastError = new Error(label + " IP banned (418)");
        await sleep(Math.min(5000 * (attempt + 1), 30000));
        continue;
      }

      if (!response.ok) {
        const error = new Error(label + " HTTP " + response.status);
        error.status = response.status;
        const retryable = response.status >= 500;
        if (!retryable || attempt === maxAttempts - 1) throw error;
        lastError = error;
        await sleep(baseDelay * (attempt + 1));
        continue;
      }

      return await response.json();
    } catch (e) {
      lastError = e;
      const status = e && e.status ? e.status : 0;
      const retryable = status === 429 || status === 418 || status >= 500 || status === 0 || e.name === "AbortError";
      if (!retryable || attempt === maxAttempts - 1) break;
      await sleep(baseDelay * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error(label + " خطای ناشناخته");
}

export function okxFetch(path, params = {}, options = {}) {
  return genericFetch(CONFIG.OKX_BASE_URL, path, params, { ...options, label: "OKX" }).then((json) => {
    if (json.code !== "0") throw new Error("OKX error: " + (json.msg || json.code || "unknown"));
    return json;
  });
}

export function binanceFetch(path, params = {}, options = {}) {
  return genericFetch(CONFIG.BINANCE_SPOT_URL, path, params, { ...options, label: "Binance" });
}

export function binanceSpotFetch(path, params = {}, options = {}) {
  return genericFetch(CONFIG.BINANCE_SPOT_URL, path, params, { ...options, label: "BinanceSpot" });
}

export function mexcFetch(path, params = {}, options = {}) {
  return genericFetch(CONFIG.MEXC_BASE_URL, path, params, { ...options, label: "MEXC" }).then((json) => {
    if (json && json.code !== undefined && json.code !== 0 && json.code !== "0" && json.code !== 200) {
      throw new Error("MEXC error: " + (json.message || json.code || "unknown"));
    }
    return json;
  });
}

export function resolveSymbolAliases(symbol) {
  const normalized = String(symbol || "").toUpperCase().replace(/[-_/:\s]/g, "");
  const aliases = CONFIG.SYMBOL_ALIASES[normalized];
  if (aliases && aliases.length > 0) return [normalized, ...aliases];
  return [normalized];
}

export async function getExchangeSymbols(force = false) {
  const now = Date.now() / 1000;
  if (!force && symbolCache.symbols.length > 0 && now - symbolCache.timestamp < CACHE_TTL.SYMBOLS) return symbolCache.symbols;
  const allSymbols = new Map();

  try {
    const binanceJson = await binanceFetch("/api/v3/exchangeInfo");
    if (binanceJson && Array.isArray(binanceJson.symbols)) {
      for (const item of binanceJson.symbols) {
        if (item.status !== "TRADING") continue;
        if (item.quoteAsset !== "USDT") continue;
        const base = String(item.baseAsset || "").toUpperCase();
        if (!base) continue;
        if (CONFIG.EXCLUDED_BASE_ASSETS.includes(base)) continue;
        if (/^X[A-Z]{4,}$/.test(base)) continue;
        allSymbols.set(base + "USDT", { symbol: base + "USDT", base, quote: "USDT", exchange: "binance" });
      }
    }
  } catch (e) {}

  try {
    const okxJson = await okxFetch("/api/v5/public/instruments", { instType: "SWAP" });
    if (Array.isArray(okxJson.data)) {
      for (const item of okxJson.data) {
        if (item.state !== "live") continue;
        if (item.settleCcy !== "USDT") continue;
        if (!String(item.instId || "").endsWith("-USDT-SWAP")) continue;
        const base = item.ctValCcy || item.baseCcy || "";
        if (!base) continue;
        if (CONFIG.EXCLUDED_BASE_ASSETS.includes(base)) continue;
        if (/^X[A-Z]{4,}$/.test(base)) continue;
        const symbol = base + "USDT";
        if (!allSymbols.has(symbol)) allSymbols.set(symbol, { symbol, base, quote: "USDT", exchange: "okx" });
      }
    }
  } catch (e) {}

  try {
    const mexcJson = await mexcFetch("/api/v1/contract/detail");
    if (mexcJson && Array.isArray(mexcJson.data)) {
      for (const item of mexcJson.data) {
        if (item.state !== 0) continue;
        if (item.quoteCoin !== "USDT") continue;
        const base = String(item.baseCoin || "").toUpperCase();
        if (!base) continue;
        if (CONFIG.EXCLUDED_BASE_ASSETS.includes(base)) continue;
        if (/^X[A-Z]{4,}$/.test(base)) continue;
        const symbol = base + "USDT";
        if (!allSymbols.has(symbol)) allSymbols.set(symbol, { symbol, base, quote: "USDT", exchange: "mexc" });
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
  if (!force && tickersCache.data.length > 0 && now - tickersCache.timestamp < CACHE_TTL.TICKERS) return tickersCache.data;
  const validSymbols = await getExchangeSymbols();
  const validSet = new Set(validSymbols.map((s) => s.symbol));
  const result = [];

  try {
    const binanceJson = await binanceFetch("/api/v3/ticker/24hr");
    if (Array.isArray(binanceJson)) {
      for (const item of binanceJson) {
        const raw = String(item.symbol || "").toUpperCase();
        if (!raw.endsWith("USDT")) continue;
        const base = raw.replace(/USDT$/, "");
        const symbol = base + "USDT";
        if (CONFIG.EXCLUDED_BASE_ASSETS.includes(base)) continue;
        if (base.includes("TEST")) continue;
        if (!validSet.has(symbol)) continue;
        const last = parseFloat(item.lastPrice || "0");
        const open24h = parseFloat(item.openPrice || "0");
        const quoteVolume = parseFloat(item.quoteVolume || "0");
        if (!Number.isFinite(last) || last <= 0) continue;
        let changePercent = 0;
        if (Number.isFinite(open24h) && open24h > 0) changePercent = ((last - open24h) / open24h) * 100;
        result.push({ symbol, base, quote: "USDT", price: last, change: changePercent, quote_volume: quoteVolume });
      }
    }
  } catch (e) {}

  try {
    const okxJson = await okxFetch("/api/v5/market/tickers", { instType: "SWAP" });
    if (Array.isArray(okxJson.data)) {
      const seen = new Set(result.map((t) => t.symbol));
      for (const item of okxJson.data) {
        if (!item.instId || !item.instId.endsWith("-USDT-SWAP")) continue;
        const base = item.instId.split("-")[0];
        if (CONFIG.EXCLUDED_BASE_ASSETS.includes(base)) continue;
        if (base.includes("TEST")) continue;
        const symbol = base + "USDT";
        if (!validSet.has(symbol)) continue;
        if (seen.has(symbol)) continue;
        const last = parseFloat(item.last || "0");
        const open24h = parseFloat(item.open24h || "0");
        const volCcy24h = parseFloat(item.volCcy24h || "0");
        const vol24h = parseFloat(item.vol24h || "0");
        if (!Number.isFinite(last) || last <= 0) continue;
        const quoteVolume = Number.isFinite(volCcy24h) && volCcy24h > 0 ? volCcy24h : Number.isFinite(vol24h) ? vol24h * last : 0;
        let changePercent = 0;
        if (Number.isFinite(open24h) && open24h > 0) changePercent = ((last - open24h) / open24h) * 100;
        result.push({ symbol, base, quote: "USDT", price: last, change: changePercent, quote_volume: quoteVolume });
        seen.add(symbol);
      }
    }
  } catch (e) {}

  try {
    const mexcJson = await mexcFetch("/api/v1/contract/ticker");
    if (mexcJson && Array.isArray(mexcJson.data)) {
      const seen = new Set(result.map((t) => t.symbol));
      for (const item of mexcJson.data) {
        const raw = String(item.symbol || "").toUpperCase();
        if (!raw.endsWith("USDT")) continue;
        const base = raw.replace(/USDT_/, "").replace(/USDT$/, "");
        const symbol = base + "USDT";
        if (CONFIG.EXCLUDED_BASE_ASSETS.includes(base)) continue;
        if (base.includes("TEST")) continue;
        if (!validSet.has(symbol)) continue;
        if (seen.has(symbol)) continue;
        const last = parseFloat(item.lastPrice || "0");
        const quoteVolume = parseFloat(item.amount24 || item.volume24 || "0");
        if (!Number.isFinite(last) || last <= 0) continue;
        let changePercent = 0;
        if (Number.isFinite(parseFloat(item.riseFallRate))) changePercent = parseFloat(item.riseFallRate) * 100;
        result.push({ symbol, base, quote: "USDT", price: last, change: changePercent, quote_volume: quoteVolume });
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
    if (!Number.isFinite(ticker.quote_volume) || ticker.quote_volume < CONFIG.MIN_QUOTE_VOLUME_24H) continue;
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
    const open = raw.open;
    const high = raw.high;
    const low = raw.low;
    const close = raw.close;
    const volume = raw.volume;
    const quoteVolume = raw.quoteVolume;
    const confirm = raw.confirm;

    if (!Number.isFinite(openTime) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue;

    const candleObj = {
      time: openTime, open_time: openTime,
      close_time: intervalMs > 0 ? openTime + intervalMs - 1 : openTime,
      open, high, low, close,
      volume: Number.isFinite(volume) ? volume : 0,
      quote_volume: Number.isFinite(quoteVolume) ? quoteVolume : 0,
      trades: 0,
      incomplete: confirm === "0"
    };

    if (confirm === "0") { incompleteCandles.push(candleObj); continue; }
    normalized.push(candleObj);
  }

  normalized.sort((a, b) => a.time - b.time);

  if (incompleteCandles.length > 0) {
    const openCandle = incompleteCandles[0];
    const latestPrice = openCandle.close;
    if (Number.isFinite(latestPrice) && latestPrice > 0) {
      normalized.push({
        time: openCandle.time, open_time: openCandle.open_time, close_time: openCandle.close_time,
        open: openCandle.open, high: Math.max(openCandle.high, latestPrice), low: Math.min(openCandle.low, latestPrice),
        close: latestPrice, volume: openCandle.volume, quote_volume: openCandle.quote_volume, trades: 0,
        incomplete: true, updated_at: now
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
  const binanceSymbol = symbol.toUpperCase();
  const binanceInterval = CONFIG.BINANCE_INTERVAL_MAP[interval];
  if (!binanceInterval) throw new Error("Binance interval unsupported: " + interval);
  const size = Math.min(limit, 1000);
  const json = await binanceSpotFetch("/api/v3/klines", { symbol: binanceSymbol, interval: binanceInterval, limit: String(size) });
  if (!Array.isArray(json)) throw new Error("Binance klines پاسخ نامعتبر");
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
    if (!Number.isFinite(openTime) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue;
    const closeTime = openTime + intervalMs - 1;
    const isClosed = Date.now() > closeTime;
    rawCandles.push({ time: openTime, open, high, low, close, volume, quoteVolume: turnover, confirm: isClosed ? "1" : "0" });
  }
  rawCandles.sort((a, b) => a.time - b.time);
  return normalizeCandles(rawCandles, interval);
}

async function getKlinesOKX(symbol, interval, limit) {
  const base = symbol.replace(/USDT$/, "");
  const okxInterval = CONFIG.OKX_INTERVAL_MAP[interval];
  if (!okxInterval) throw new Error("OKX interval unsupported: " + interval);
  const barLimit = Math.min(limit, 300);
  const swapInstId = base + "-USDT-SWAP";

  try {
    const swapJson = await okxFetch("/api/v5/market/candles", { instId: swapInstId, bar: okxInterval, limit: String(barLimit) }, { maxAttempts: 3, baseDelay: 400 });
    if (Array.isArray(swapJson.data) && swapJson.data.length > 0) {
      const rawCandles = swapJson.data.map(row => ({
        time: parseInt(row[0], 10), open: parseFloat(row[1]), high: parseFloat(row[2]), low: parseFloat(row[3]),
        close: parseFloat(row[4]), volume: parseFloat(row[5]), quoteVolume: parseFloat(row[6]), confirm: String(row[8] ?? "1")
      })).reverse();
      return normalizeCandles(rawCandles, interval);
    }
  } catch (e) {}

  const spotInstId = base + "-USDT";
  const spotJson = await okxFetch("/api/v5/market/candles", { instId: spotInstId, bar: okxInterval, limit: String(barLimit) }, { maxAttempts: 3, baseDelay: 400 });
  if (!Array.isArray(spotJson.data)) throw new Error("OKX klines پاسخ نامعتبر");
  const rawCandles = spotJson.data.map(row => ({
    time: parseInt(row[0], 10), open: parseFloat(row[1]), high: parseFloat(row[2]), low: parseFloat(row[3]),
    close: parseFloat(row[4]), volume: parseFloat(row[5]), quoteVolume: parseFloat(row[6]), confirm: String(row[8] ?? "1")
  })).reverse();
  return normalizeCandles(rawCandles, interval);
}

async function getKlinesMEXC(symbol, interval, limit) {
  const base = symbol.replace(/USDT$/, "");
  const mexcSymbol = base + "_USDT";
  const mexcInterval = CONFIG.MEXC_INTERVAL_MAP[interval];
  if (!mexcInterval) throw new Error("MEXC interval unsupported: " + interval);
  const size = Math.min(limit, 1000);
  const json = await mexcFetch("/api/v1/contract/kline/" + mexcSymbol, { interval: mexcInterval, limit: String(size) });
  if (!json || !json.data) throw new Error("MEXC klines پاسخ نامعتبر");
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
    if (!Number.isFinite(openTime) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue;
    const closeTime = openTime + intervalMs - 1;
    const isClosed = Date.now() > closeTime;
    rawCandles.push({ time: openTime, open, high, low, close, volume, quoteVolume: 0, confirm: isClosed ? "1" : "0" });
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
        case "binance": candles = await getKlinesBinance(alias, interval, limit); break;
        case "okx": candles = await getKlinesOKX(alias, interval, limit); break;
        case "mexc": candles = await getKlinesMEXC(alias, interval, limit); break;
        default: throw new Error("Unknown exchange: " + exchangeKey);
      }
      if (candles && candles.length > 0) return candles;
    } catch (e) { lastError = e; continue; }
  }
  throw lastError || new Error("No candles for " + symbol + " on " + exchangeKey);
}

function getExchangeOrder() {
  const keys = Object.keys(CONFIG.EXCHANGES);
  keys.sort((a, b) => CONFIG.EXCHANGES[a].priority - CONFIG.EXCHANGES[b].priority);
  return keys.filter((k) => CONFIG.EXCHANGES[k].enabled);
}

export async function getKlines(symbol, interval, limit = CONFIG.KLINE_LIMIT) {
  const cacheKey = symbol + ":" + interval;
  const cached = klineCache[cacheKey];
  if (cached && Date.now() - cached.time < CACHE_TTL.KLINES * 1000) return cached.candles;

  const exchanges = getExchangeOrder();
  const attempts = exchanges.map(async (exchangeKey) => {
    const candles = await getKlinesFromExchange(exchangeKey, symbol, interval, limit);
    if (!candles || candles.length < 100) throw new Error("Not enough candles from " + exchangeKey + " (" + (candles ? candles.length : 0) + ")");
    return { candles, exchange: exchangeKey };
  });

  try {
    const winner = await Promise.any(attempts);
    klineCache[cacheKey] = { time: Date.now(), candles: winner.candles, exchange: winner.exchange };
    return winner.candles;
  } catch (aggErr) {
    throw new Error("هیچ صرافی داده‌ای برنگرداند");
  }
}

export async function getMarketSnapshot(symbol, timeframe) {
  const snapshotKey = symbol + ":" + timeframe;
  const cached = snapshotCache[snapshotKey];
  if (cached && Date.now() - cached.time < CACHE_TTL.SNAPSHOT * 1000) return cached.snapshot;

  const current = await getKlines(symbol, timeframe);

  const snapshot = { current, timeframe };

  snapshotCache[snapshotKey] = { time: Date.now(), snapshot };
  return snapshot;
}
