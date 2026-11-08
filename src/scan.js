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
import { getTopSymbols } from "./exchanges.js";
import { analyze } from "./analysis.js";
import { formatAnalysis, formatSignalResult } from "./format.js";
import { updateSignalStatus, computeStats } from "./tracker.js";

const SCAN_TIMEFRAMES = [CONFIG.TIMEFRAME];
const CONCURRENCY = 5;
const MESSAGE_DELAY_MS = 1500;
const TOTAL_TIMEOUT_MS = 55 * 60 * 1000;
const MAX_RECENT_SIGNALS = 200;
const TELEGRAM_TIMEOUT_MS = 15000;

const STICKER_SIGNAL = "CAACAgQAAxkBAAFWjQ1q2xyIAAF8RW6SvzA1h0AiPVmvNMIAAtYmAAJDOdlS8xWIfVV7lSo9BA";
const STICKER_UPDATE = "CAACAgQAAxkBAAFWjMVq2xZDZ25oGXqwmgaGPxZHzvL-AAPuHwACUaTYUjhywde8jk-nPQQ";

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
      signal &&
      (signal.status === "active" || signal.status === "pending")
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
        console.error(
          "Failed to send result for " + signal.symbol + ":",
          e.message || e
        );
      }
    }

    if (signal.status !== result.status) {
      summary.tracked++;
      console.log(
        signal.symbol + " [" + signal.timeframe + "] -> " + result.status
      );
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
    "Fetched " + symbols.length +
    " symbols x " + SCAN_TIMEFRAMES.length +
    " timeframes = " + summary.total + " tasks"
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
        return { symbol, timeframe, status: "no_signal" };
      }

      if (analysis.status !== "LONG" && analysis.status !== "SHORT") {
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
        console.error(
          "Analysis error for " + result.symbol + ": " + result.error
        );
      }
    } else if (result.status === "signal") {
      summary.analyzed++;
      summary.signals++;
      signals.push(result);
    }
  }

  console.log(
    "Scan complete: " +
    summary.analyzed + " analyzed, " +
    summary.skipped + " skipped, " +
    summary.signals + " signals"
  );

  let signalStickerSent = false;

  for (const item of signals) {
    if (Date.now() - startTime > TOTAL_TIMEOUT_MS) break;

    const { symbol, timeframe, analysis } = item;

    try {
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
        "Sent: " + symbol +
        " (" + analysis.direction +
        ", entry " + analysis.entry +
        ", RR " + analysis.rr.toFixed(2) + ")"
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
