import {
  readCache, writeCache, cleanOldSignals, hasRecentSignal, addSignal,
  readStats, writeStats
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

const STICKER_SIGNAL = "CAACAgQAAxkBAAFWjQ1q2xyIAAF8RW6SvzA1h0AiPVmvNMIAAtYmAAJDOdlS8xWIfVV7lSo9BA";
const STICKER_UPDATE = "CAACAgQAAxkBAAFWjMVq2xZDZ25oGXqwmgaGPxZHzvL-AAPuHwACUaTYUjhywde8jk-nPQQ";

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function sendTelegramMessage(token, chatId, text) {
  const url = "https://api.telegram.org/bot" + token + "/sendMessage";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
  const responseText = await response.text();
  let data = null;
  try { data = JSON.parse(responseText); } catch { data = null; }
  if (!response.ok || !data || data.ok !== true) {
    throw new Error(data && data.description ? data.description : "Telegram API error");
  }
  return data;
}

async function sendTelegramSticker(token, chatId, stickerFileId) {
  const url = "https://api.telegram.org/bot" + token + "/sendSticker";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, sticker: stickerFileId })
  });
  const responseText = await response.text();
  let data = null;
  try { data = JSON.parse(responseText); } catch { data = null; }
  if (!response.ok || !data || data.ok !== true) throw new Error("Telegram sticker error");
  return data;
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runner() {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) return;
      try { results[currentIndex] = await worker(items[currentIndex], currentIndex); }
      catch (e) { results[currentIndex] = { error: e }; }
    }
  }
  const runners = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) runners.push(runner());
  await Promise.all(runners);
  return results;
}

function isNotified(sig, eventType) {
  if (eventType === "tp1_hit") return sig._tp1Notified === true;
  if (eventType === "stopped") return sig._stoppedNotified === true;
  return false;
}

function markNotified(sig, eventType) {
  if (eventType === "tp1_hit") sig._tp1Notified = true;
  else if (eventType === "stopped") sig._stoppedNotified = true;
}

async function main() {
  const startTime = Date.now();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.error("❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID environment variables.");
    process.exit(1);
  }

  const summary = {
    total: 0, skipped: 0, analyzed: 0, signals: 0, sent: 0,
    tracked: 0, missed: 0, cleaned: 0, cacheEntries: 0, elapsedMs: 0
  };

  console.log("");
  console.log("🚀 Starting crypto trendline scan...");
  console.log("⏱  Timeframe: " + CONFIG.TIMEFRAME);
  console.log("");

  let cache = await readCache();
  cache.signals = cleanOldSignals(cache.signals);

  let stats = await readStats();
  if (!Array.isArray(stats.recentSignals)) stats.recentSignals = [];
  if (!stats.processedSignals) stats.processedSignals = {};

  console.log("📥 Loaded cache: " + Object.keys(cache.signals).length + " active signal(s)");
  console.log("📊 Loaded stats: " + stats.recentSignals.length + " tracked signal(s)");
  console.log("");

  console.log("🔄 Updating existing signal statuses...");

  const trackingTasks = stats.recentSignals
    .map((sig, idx) => ({ sig, idx }))
    .filter(({ sig }) => sig && (sig.status === "active" || sig.status === "pending"));

  const trackedResults = await runWithConcurrency(trackingTasks, 3, async ({ sig, idx }) => {
    if (Date.now() - startTime > TOTAL_TIMEOUT_MS) {
      return { idx, status: sig.status, skipped: true, events: [], exitPrice: null };
    }
    const result = await updateSignalStatus(sig);
    return { idx, ...result };
  });

  let updateStickerSent = false;

  for (const r of trackedResults) {
    if (!r || r.skipped) continue;
    const sig = stats.recentSignals[r.idx];
    if (!sig) continue;

    if (Number.isFinite(r.exitPrice)) sig.exitPrice = r.exitPrice;

    const events = Array.isArray(r.events) ? r.events : [];

    const hasUnnotifiedEvent = events.some((event) => {
      if (event.type !== "tp1_hit" && event.type !== "stopped") return false;
      return !isNotified(sig, event.type);
    });

    if (hasUnnotifiedEvent && !updateStickerSent && STICKER_UPDATE) {
      try {
        await sendTelegramSticker(token, chatId, STICKER_UPDATE);
        await sleep(MESSAGE_DELAY_MS);
        updateStickerSent = true;
      } catch (e) {
        console.error("❌ Failed to send UPDATE sticker:", (e && e.message) || e);
      }
    }

    for (const event of events) {
      if (event.type === "tp1_hit" || event.type === "stopped") {
        if (isNotified(sig, event.type)) continue;

        try {
          const resultText = formatSignalResult(sig, event.type);
          if (resultText && resultText.trim() !== "") {
            await sendTelegramMessage(token, chatId, resultText);
            await sleep(MESSAGE_DELAY_MS);
            console.log("   📤 Sent: " + sig.symbol + " → " + event.type);
            markNotified(sig, event.type);
          }
        } catch (e) {
          console.error("❌ Failed to send result for " + sig.symbol + " (" + event.type + "):", (e && e.message) || e);
        }
      }
    }

    if (sig.status !== r.status) {
      summary.tracked++;
      console.log("   📊 " + sig.symbol + " [" + sig.timeframe + "] → " + r.status);
    }

    sig.status = r.status;
    sig.statusUpdatedAt = new Date().toISOString();
  }

  const beforeCleanup = stats.recentSignals.length;
  stats.recentSignals = stats.recentSignals.filter(
    (sig) => sig && sig.status !== "tp1_hit" && sig.status !== "stopped"
  );
  summary.cleaned = beforeCleanup - stats.recentSignals.length;

  if (summary.cleaned > 0) {
    console.log("🧹 Removed " + summary.cleaned + " completed signal(s)");
  }

  console.log("✅ Tracking complete: " + summary.tracked + " status change(s)");
  console.log("");

  let symbols = [];
  try { symbols = await getTopSymbols(CONFIG.MARKET_TOP_LIMIT); }
  catch (e) { console.error("❌ Failed to fetch top symbols:", e.message || e); process.exit(1); }

  summary.total = symbols.length * SCAN_TIMEFRAMES.length;
  console.log("📈 Fetched " + symbols.length + " symbols × " + SCAN_TIMEFRAMES.length + " timeframes = " + summary.total + " tasks");
  console.log("");

  const tasks = [];
  for (const item of symbols) {
    for (const tf of SCAN_TIMEFRAMES) tasks.push({ symbol: item.symbol, timeframe: tf });
  }

  const results = await runWithConcurrency(tasks, CONCURRENCY, async (task) => {
    const { symbol, timeframe } = task;
    if (Date.now() - startTime > TOTAL_TIMEOUT_MS) return { symbol, timeframe, status: "timeout" };
    if (hasRecentSignal(cache.signals, symbol, timeframe)) return { symbol, timeframe, status: "skipped" };

    let analysis;
    try { analysis = await analyze(symbol); }
    catch (e) { return { symbol, timeframe, status: "error", error: (e && e.message) || "unknown" }; }

    if (analysis.status === "NO_TRADE") return { symbol, timeframe, status: "no_signal" };
    if (analysis.status === "WAIT") return { symbol, timeframe, status: "missed", reason: "منتظر پولبک" };

    return { symbol, timeframe, status: "signal", analysis };
  });

  const signals = [];
  for (const result of results) {
    if (!result) continue;
    if (result.status === "skipped") summary.skipped++;
    else if (result.status === "missed") { summary.analyzed++; summary.missed++; }
    else if (result.status === "no_signal" || result.status === "error") summary.analyzed++;
    else if (result.status === "signal") { summary.analyzed++; summary.signals++; signals.push(result); }
  }

  console.log("✅ Scan complete: " + summary.analyzed + " analyzed, " + summary.skipped + " skipped, " + summary.signals + " signal(s), " + summary.missed + " missed");

  let signalStickerSent = false;

  for (const signal of signals) {
    const { symbol, timeframe, analysis } = signal;

    try {
      if (!signalStickerSent && STICKER_SIGNAL) {
        try { await sendTelegramSticker(token, chatId, STICKER_SIGNAL); await sleep(MESSAGE_DELAY_MS); signalStickerSent = true; } catch (e) {}
      }

      const text = formatAnalysis(analysis);
      await sendTelegramMessage(token, chatId, text);

      const sentAt = new Date().toISOString();
      const sigKey = symbol + ":" + timeframe + ":" + sentAt;

      cache.signals = addSignal(cache.signals, symbol, timeframe, {
        direction: analysis.direction,
        entry: analysis.entry,
        stop: analysis.stop_loss
      });

      stats.processedSignals[sigKey] = {
        symbol, timeframe, direction: analysis.direction, status: "active", sentAt
      };

      stats.recentSignals.push({
        symbol, timeframe, direction: analysis.direction,
        entry: analysis.entry, stop: analysis.stop_loss,
        tp1: analysis.take_profit,
        rr1: analysis.rr,
        sentAt, status: "active", activated: true,
        statusUpdatedAt: new Date().toISOString(), maxR: 0,
        tp1Reached: false,
        _tp1Notified: false, _stoppedNotified: false
      });

      try { await writeCache(cache); }
      catch (e) { console.error("⚠️ Failed to write cache after send:", (e && e.message) || e); }

      summary.sent++;
      console.log("📤 Sent: " + symbol + " (" + analysis.direction + ", entry " + analysis.entry + ")");
    } catch (e) {
      console.error("❌ Failed to send " + symbol + ":", (e && e.message) || e);
    }

    await sleep(MESSAGE_DELAY_MS);
  }

  cache.signals = cleanOldSignals(cache.signals);
  if (stats.recentSignals.length > MAX_RECENT_SIGNALS) stats.recentSignals = stats.recentSignals.slice(-MAX_RECENT_SIGNALS);

  const computed = computeStats(stats.recentSignals);
  stats.allTime = computed.allTime;
  stats.byDirection = computed.byDirection;

  try { await writeCache(cache); }
  catch (e) { console.error("❌ Failed to write cache:", (e && e.message) || e); }

  try { await writeStats(stats); }
  catch (e) { console.error("❌ Failed to write stats:", (e && e.message) || e); }

  summary.cacheEntries = Object.keys(cache.signals).length;
  summary.elapsedMs = Date.now() - startTime;

  console.log("");
  console.log("═══════════════════════════════════════════");
  console.log("📊 SCAN SUMMARY");
  console.log("═══════════════════════════════════════════");
  console.log("📈 Total symbol×TF      : " + summary.total);
  console.log("⏭  Skipped (cached)     : " + summary.skipped);
  console.log("🔎 Analyzed             : " + summary.analyzed);
  console.log("✨ Signals detected     : " + summary.signals);
  console.log("📤 Sent                 : " + summary.sent);
  console.log("🔄 Tracked (updated)    : " + summary.tracked);
  console.log("🚫 Missed/Invalidated   : " + summary.missed);
  console.log("🧹 Cleaned (completed)  : " + summary.cleaned);
  console.log("📥 Cache entries        : " + summary.cacheEntries);
  console.log("🕐 Elapsed              : " + (summary.elapsedMs / 1000).toFixed(1) + "s");
  console.log("═══════════════════════════════════════════");
  console.log("");

  process.exit(0);
}

main().catch((e) => { console.error("❌ Fatal error:", (e && e.stack) || e); process.exit(1); });
