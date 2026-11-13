import {
  readCache,
  writeCache,
  cleanOldSignals,
  hasRecentSignal,
  addSignal,
  readStats,
  writeStats
} from "./cache.js";
import { CONFIG } from "./config.js";
import { getTopSymbols, getKlines } from "./exchanges.js";
import { analyze } from "./analysis.js";
import { calculateATR } from "./indicators.js";
import { formatAnalysis, formatSignalResult } from "./format.js";
import { updateSignalStatus, computeStats } from "./tracker.js";

const SCAN_TIMEFRAMES = CONFIG.SCAN_TIMEFRAMES;
const CONCURRENCY = CONFIG.CONCURRENCY;
const MESSAGE_DELAY_MS = CONFIG.MESSAGE_DELAY_MS;
const TOTAL_TIMEOUT_MS = CONFIG.TOTAL_TIMEOUT_MS;
const MAX_RECENT_SIGNALS = CONFIG.MAX_RECENT_SIGNALS;
const TELEGRAM_TIMEOUT_MS = CONFIG.TELEGRAM_TIMEOUT_MS;

const HOURLY_TIMEFRAME = CONFIG.HOURLY_TIMEFRAME;
const HOURLY_ATR_PERIOD = CONFIG.HOURLY_ATR_PERIOD;
const HOURLY_MIN_CANDLES = CONFIG.HOURLY_MIN_CANDLES;
const HOURLY_SWING_STRENGTH = CONFIG.HOURLY_SWING_STRENGTH;
const HOURLY_IMPULSE_LOOKBACK = CONFIG.HOURLY_IMPULSE_LOOKBACK;
const HOURLY_IMPULSE_ATR_MULTIPLIER = CONFIG.HOURLY_IMPULSE_ATR_MULTIPLIER;
const HOURLY_REVERSAL_LOOKBACK = CONFIG.HOURLY_REVERSAL_LOOKBACK;
const HOURLY_REVERSAL_BODY_ATR = CONFIG.HOURLY_REVERSAL_BODY_ATR;

const STICKER_SIGNAL = CONFIG.STICKER_SIGNAL;
const STICKER_UPDATE = CONFIG.STICKER_UPDATE;

const DEBUG_SYMBOLS = CONFIG.DEBUG_SYMBOLS;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function telegramRequest(token, method, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

  try {
    const response = await fetch(
      "https://api.telegram.org/bot" + token + "/" + method,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      }
    );

    const responseText = await response.text();
    let data = null;

    try {
      data = JSON.parse(responseText);
    } catch {
      data = null;
    }

    if (!response.ok || !data || data.ok !== true) {
      throw new Error(data?.description || "Telegram API error: " + response.status);
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendTelegramMessage(token, chatId, message) {
  return telegramRequest(token, "sendMessage", {
    chat_id: chatId,
    text: message,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function sendTelegramSticker(token, chatId, stickerFileId) {
  return telegramRequest(token, "sendSticker", {
    chat_id: chatId,
    sticker: stickerFileId
  });
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) return;

      try {
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      } catch (e) {
        results[currentIndex] = { error: e };
      }
    }
  }

  const runners = [];

  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    runners.push(runner());
  }

  await Promise.all(runners);
  return results;
}

function isNotified(signal, eventType) {
  if (eventType === "tp1_hit") return signal._tp1Notified === true;
  if (eventType === "stopped") return signal._stoppedNotified === true;
  return false;
}

function markNotified(signal, eventType) {
  if (eventType === "tp1_hit") signal._tp1Notified = true;
  if (eventType === "stopped") signal._stoppedNotified = true;
}

function normalizeDirection(direction) {
  if (direction === "LONG" || direction === "bullish") return "LONG";
  if (direction === "SHORT" || direction === "bearish") return "SHORT";
  return null;
}

function isValidHourlyCandle(candle) {
  return (
    candle &&
    candle.incomplete !== true &&
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

function detectHourlySwings(candles, strength = HOURLY_SWING_STRENGTH) {
  const highs = [];
  const lows = [];

  if (!Array.isArray(candles) || candles.length < strength * 2 + 1) {
    return { highs, lows };
  }

  for (
    let i = strength;
    i < candles.length - strength;
    i++
  ) {
    const current = candles[i];

    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= strength; j++) {
      if (
        current.high <= candles[i - j].high ||
        current.high <= candles[i + j].high
      ) {
        isHigh = false;
      }

      if (
        current.low >= candles[i - j].low ||
        current.low >= candles[i + j].low
      ) {
        isLow = false;
      }

      if (!isHigh && !isLow) break;
    }

    if (isHigh) {
      highs.push({
        index: i,
        price: current.high
      });
    }

    if (isLow) {
      lows.push({
        index: i,
        price: current.low
      });
    }
  }

  return { highs, lows };
}

function detectHourlyStructure(candles) {
  const { highs, lows } = detectHourlySwings(candles);

  if (highs.length < 2 || lows.length < 2) {
    return "neutral";
  }

  const previousHigh = highs[highs.length - 2];
  const latestHigh = highs[highs.length - 1];

  const previousLow = lows[lows.length - 2];
  const latestLow = lows[lows.length - 1];

  const higherHigh = latestHigh.price > previousHigh.price;
  const higherLow = latestLow.price > previousLow.price;

  const lowerHigh = latestHigh.price < previousHigh.price;
  const lowerLow = latestLow.price < previousLow.price;

  if (higherHigh && higherLow) {
    return "bullish";
  }

  if (lowerHigh && lowerLow) {
    return "bearish";
  }

  return "neutral";
}

function detectHourlyReversal(candles, atr) {
  const lastCandle = candles[candles.length - 1];

  const previousCandles = candles.slice(
    -(HOURLY_REVERSAL_LOOKBACK + 1),
    -1
  );

  if (
    !lastCandle ||
    previousCandles.length !== HOURLY_REVERSAL_LOOKBACK
  ) {
    return {
      bullish: false,
      bearish: false
    };
  }

  const previousHighest = Math.max(
    ...previousCandles.map(candle => candle.high)
  );

  const previousLowest = Math.min(
    ...previousCandles.map(candle => candle.low)
  );

  const bodySize = Math.abs(
    lastCandle.close - lastCandle.open
  );

  const strongBody = bodySize >= atr * HOURLY_REVERSAL_BODY_ATR;

  return {
    bullish:
      lastCandle.close > lastCandle.open &&
      lastCandle.close > previousHighest &&
      strongBody,

    bearish:
      lastCandle.close < lastCandle.open &&
      lastCandle.close < previousLowest &&
      strongBody
  };
}

function detectHourlyImpulse(candles, atr) {
  const recentCandles = candles.slice(-HOURLY_IMPULSE_LOOKBACK);

  if (recentCandles.length !== HOURLY_IMPULSE_LOOKBACK) {
    return {
      sharpDecline: false,
      sharpRise: false
    };
  }

  const firstCandle = recentCandles[0];
  const lastCandle = recentCandles[recentCandles.length - 1];

  const previousCandle = candles[candles.length - 2];

  if (!previousCandle) {
    return {
      sharpDecline: false,
      sharpRise: false
    };
  }

  const impulseSize = lastCandle.close - firstCandle.open;

  return {
    sharpDecline:
      impulseSize <= -(atr * HOURLY_IMPULSE_ATR_MULTIPLIER) &&
      lastCandle.close < previousCandle.close,

    sharpRise:
      impulseSize >= atr * HOURLY_IMPULSE_ATR_MULTIPLIER &&
      lastCandle.close > previousCandle.close
  };
}

function isHourlyCounterTrendBlocked(candles, direction) {
  const normalizedDirection = normalizeDirection(direction);

  if (!normalizedDirection || !Array.isArray(candles)) {
    return false;
  }

  const closedCandles = candles.filter(isValidHourlyCandle);

  if (closedCandles.length < HOURLY_MIN_CANDLES) {
    return false;
  }

  const atr = calculateATR(closedCandles, HOURLY_ATR_PERIOD);

  if (!Number.isFinite(atr) || atr <= 0) {
    return false;
  }

  const structure = detectHourlyStructure(closedCandles);
  const reversal = detectHourlyReversal(closedCandles, atr);
  const impulse = detectHourlyImpulse(closedCandles, atr);

  if (normalizedDirection === "LONG") {
    const bearishStructure = structure === "bearish";

    return (
      (bearishStructure || impulse.sharpDecline) &&
      !reversal.bullish
    );
  }

  if (normalizedDirection === "SHORT") {
    const bullishStructure = structure === "bullish";

    return (
      (bullishStructure || impulse.sharpRise) &&
      !reversal.bearish
    );
  }

  return false;
}

async function passesHourlyFilter(symbol, direction) {
  try {
    const candles = await getKlines(
      symbol,
      HOURLY_TIMEFRAME,
      CONFIG.KLINE_LIMIT
    );

    const blocked = isHourlyCounterTrendBlocked(
      candles,
      direction
    );

    if (blocked) {
      console.log(
        "[1H FILTER] " +
        symbol +
        " blocked " +
        normalizeDirection(direction)
      );
    }

    return !blocked;
  } catch (e) {
    console.error(
      "[1H FILTER] Failed for " + symbol + ": " + (e.message || e)
    );

    return true;
  }
}

async function main() {
  const startTime = Date.now();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID environment variables.");
  }

  const summary = {
    total: 0,
    skipped: 0,
    analyzed: 0,
    signals: 0,
    sent: 0,
    tracked: 0,
    missed: 0,
    cleaned: 0,
    cacheEntries: 0,
    elapsedMs: 0
  };

  console.log("");
  console.log("Starting crypto trendline scan...");
  console.log("Timeframe: " + CONFIG.TIMEFRAME);
  console.log("");

  const cache = await readCache();
  cache.signals = cleanOldSignals(cache.signals);

  const stats = await readStats();

  if (!Array.isArray(stats.recentSignals)) stats.recentSignals = [];

  if (!stats.processedSignals || typeof stats.processedSignals !== "object") {
    stats.processedSignals = {};
  }

  console.log("Loaded cache: " + Object.keys(cache.signals).length);
  console.log("Tracked signals: " + stats.recentSignals.length);

  const trackingTasks = stats.recentSignals
    .map((signal, index) => ({ signal, index }))
    .filter(({ signal }) =>
      signal && (signal.status === "active" || signal.status === "pending")
    );

  const trackedResults = await runWithConcurrency(
    trackingTasks,
    3,
    async ({ signal, index }) => {
      if (Date.now() - startTime > TOTAL_TIMEOUT_MS) {
        return {
          index,
          skipped: true,
          status: signal.status,
          events: [],
          exitPrice: null
        };
      }

      const result = await updateSignalStatus(signal);
      return { index, ...result };
    }
  );

  let updateStickerSent = false;

  for (const result of trackedResults) {
    if (!result || result.skipped) continue;

    const signal = stats.recentSignals[result.index];
    if (!signal) continue;

    if (Number.isFinite(result.exitPrice)) {
      signal.exitPrice = result.exitPrice;
    }

    const events = Array.isArray(result.events) ? result.events : [];

    const hasUnnotifiedEvent = events.some(event =>
      (event.type === "tp1_hit" || event.type === "stopped") &&
      !isNotified(signal, event.type)
    );

    if (hasUnnotifiedEvent && !updateStickerSent && STICKER_UPDATE) {
      try {
        await sendTelegramSticker(token, chatId, STICKER_UPDATE);
        await sleep(MESSAGE_DELAY_MS);
        updateStickerSent = true;
      } catch (e) {
        console.error("Failed to send update sticker:", e.message || e);
      }
    }

    for (const event of events) {
      if (event.type !== "tp1_hit" && event.type !== "stopped") continue;
      if (isNotified(signal, event.type)) continue;

      try {
        const message = formatSignalResult(signal, event.type);

        if (message) {
          await sendTelegramMessage(token, chatId, message);
          markNotified(signal, event.type);
          await sleep(MESSAGE_DELAY_MS);
        }
      } catch (e) {
        console.error("Failed to send result for " + signal.symbol + ":", e.message || e);
      }
    }

    if (signal.status !== result.status) {
      summary.tracked++;
      console.log(signal.symbol + " [" + signal.timeframe + "] -> " + result.status);
    }

    signal.status = result.status;
    signal.statusUpdatedAt = new Date().toISOString();
  }

  console.log("Tracking complete: " + summary.tracked + " status changes");

  let symbols = [];

  try {
    symbols = await getTopSymbols(CONFIG.MARKET_TOP_LIMIT);
  } catch (e) {
    throw new Error("Failed to fetch top symbols: " + (e.message || e));
  }

  summary.total = symbols.length * SCAN_TIMEFRAMES.length;

  console.log(
    "Fetched " +
    symbols.length +
    " symbols x " +
    SCAN_TIMEFRAMES.length +
    " timeframes = " +
    summary.total +
    " tasks"
  );

  const tasks = [];

  for (const item of symbols) {
    for (const timeframe of SCAN_TIMEFRAMES) {
      tasks.push({ symbol: item.symbol, timeframe });
    }
  }

  const results = await runWithConcurrency(
    tasks,
    CONCURRENCY,
    async task => {
      const { symbol, timeframe } = task;

      if (Date.now() - startTime > TOTAL_TIMEOUT_MS) {
        return { symbol, timeframe, status: "timeout" };
      }

      if (hasRecentSignal(cache.signals, symbol, timeframe)) {
        return { symbol, timeframe, status: "skipped" };
      }

      let analysis;

      try {
        analysis = await analyze(symbol, timeframe);
      } catch (e) {
        return {
          symbol,
          timeframe,
          status: "error",
          error: e.message || "unknown"
        };
      }

      if (!analysis || analysis.status === "NO_TRADE") {
        if (DEBUG_SYMBOLS.includes(symbol)) {
          const reasons = analysis?.reasons
            ? analysis.reasons.join(" | ")
            : "Unknown";

          console.log("[DEBUG] " + symbol + " -> NO_SIGNAL | Reason: " + reasons);
        }

        return { symbol, timeframe, status: "no_signal" };
      }

      if (analysis.status !== "LONG" && analysis.status !== "SHORT") {
        if (DEBUG_SYMBOLS.includes(symbol)) {
          console.log("[DEBUG] " + symbol + " -> INVALID_STATUS: " + analysis.status);
        }

        return { symbol, timeframe, status: "no_signal" };
      }

      return { symbol, timeframe, status: "signal", analysis };
    }
  );

  const signals = [];

  for (const result of results) {
    if (!result) continue;

    if (result.status === "skipped") {
      summary.skipped++;
    } else if (
      result.status === "no_signal" ||
      result.status === "error" ||
      result.status === "timeout"
    ) {
      summary.analyzed++;

      if (result.error) {
        console.error("Analysis error for " + result.symbol + ": " + result.error);
      }
    } else if (result.status === "signal") {
      summary.analyzed++;
      summary.signals++;
      signals.push(result);
    }
  }

  console.log(
    "Scan complete: " +
    summary.analyzed +
    " analyzed, " +
    summary.skipped +
    " skipped, " +
    summary.signals +
    " signals"
  );

  let signalStickerSent = false;

  for (const item of signals) {
    if (Date.now() - startTime > TOTAL_TIMEOUT_MS) break;

    const { symbol, timeframe, analysis } = item;

    try {
      const passesHourly = await passesHourlyFilter(
        symbol,
        analysis.direction
      );

      if (!passesHourly) {
        continue;
      }

      if (!signalStickerSent && STICKER_SIGNAL) {
        try {
          await sendTelegramSticker(token, chatId, STICKER_SIGNAL);
          await sleep(MESSAGE_DELAY_MS);
          signalStickerSent = true;
        } catch (e) {
          console.error("Failed to send signal sticker:", e.message || e);
        }
      }

      await sendTelegramMessage(token, chatId, formatAnalysis(analysis));

      const sentAt = new Date().toISOString();
      const signalKey = symbol + ":" + timeframe + ":" + sentAt;

      const signalData = {
        symbol,
        timeframe,
        direction: analysis.direction,
        entry: analysis.entry,
        stop: analysis.stop_loss,
        tp1: analysis.take_profit,
        zoneLow: analysis.zone_low,
        zoneHigh: analysis.zone_high,
        signalCandleTime: analysis.signal_candle_time,
        rr1: analysis.rr,
        highs: analysis.highs,
        lows: analysis.lows,
        sentAt,
        status: "active",
        activated: true,
        statusUpdatedAt: sentAt,
        maxR: 0,
        tp1Reached: false,
        _tp1Notified: false,
        _stoppedNotified: false
      };

      cache.signals = addSignal(
        cache.signals,
        symbol,
        timeframe,
        signalData
      );

      stats.processedSignals[signalKey] = {
        symbol,
        timeframe,
        direction: analysis.direction,
        status: "active",
        sentAt
      };

      stats.recentSignals.push(signalData);

      summary.sent++;

      console.log(
        "Sent: " +
        symbol +
        " (" +
        analysis.direction +
        ", entry " +
        analysis.entry +
        ", RR " +
        analysis.rr.toFixed(2) +
        ")"
      );
    } catch (e) {
      console.error("Failed to send " + symbol + ":", e.message || e);
    }

    await sleep(MESSAGE_DELAY_MS);
  }

  cache.signals = cleanOldSignals(cache.signals);

  if (stats.recentSignals.length > MAX_RECENT_SIGNALS) {
    stats.recentSignals = stats.recentSignals.slice(-MAX_RECENT_SIGNALS);
  }

  const computed = computeStats(stats.recentSignals);

  stats.allTime = computed.allTime;
  stats.byDirection = computed.byDirection;

  try {
    await writeCache(cache);
  } catch (e) {
    console.error("Failed to write cache:", e.message || e);
  }

  try {
    await writeStats(stats);
  } catch (e) {
    console.error("Failed to write stats:", e.message || e);
  }

  summary.cacheEntries = Object.keys(cache.signals).length;
  summary.elapsedMs = Date.now() - startTime;

  console.log("");
  console.log("========== SCAN SUMMARY ==========");
  console.log("Total tasks       : " + summary.total);
  console.log("Skipped           : " + summary.skipped);
  console.log("Analyzed          : " + summary.analyzed);
  console.log("Signals detected  : " + summary.signals);
  console.log("Signals sent      : " + summary.sent);
  console.log("Tracked changes   : " + summary.tracked);
  console.log("Cache entries     : " + summary.cacheEntries);
  console.log("Elapsed           : " + (summary.elapsedMs / 1000).toFixed(1) + "s");
  console.log("==================================");
}

main().catch(e => {
  console.error("Fatal error:", e.stack || e);
  process.exitCode = 1;
});
