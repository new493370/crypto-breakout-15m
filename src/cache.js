import { promises as fs } from "fs";
import path from "path";

const CACHE_DIR = path.join(process.cwd(), "cache");
const CACHE_FILE = path.join(CACHE_DIR, "signals.json");
const STATS_FILE = path.join(CACHE_DIR, "stats.json");

const MAX_AGE_MS = 15 * 60 * 1000;

async function ensureCacheDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

function makeKey(symbol, timeframe) {
  return symbol + ":" + timeframe;
}

export async function readCache() {
  try {
    await ensureCacheDir();
    const content = await fs.readFile(CACHE_FILE, "utf-8");
    const data = JSON.parse(content);
    if (!data || typeof data !== "object") {
      return { lastUpdated: new Date().toISOString(), signals: {} };
    }
    if (!data.signals || typeof data.signals !== "object") data.signals = {};
    return data;
  } catch (e) {
    return { lastUpdated: new Date().toISOString(), signals: {} };
  }
}

export async function writeCache(data) {
  await ensureCacheDir();
  const payload = {
    lastUpdated: new Date().toISOString(),
    signals: data && data.signals ? data.signals : {}
  };
  await fs.writeFile(CACHE_FILE, JSON.stringify(payload, null, 2), "utf-8");
}

export function cleanOldSignals(signals, maxAgeMs = MAX_AGE_MS) {
  const now = Date.now();
  const cleaned = {};
  for (const [key, entry] of Object.entries(signals || {})) {
    if (!entry || !entry.sentAt) continue;
    const sentAt = new Date(entry.sentAt).getTime();
    if (!Number.isFinite(sentAt)) continue;
    if (now - sentAt > maxAgeMs) continue;
    cleaned[key] = entry;
  }
  return cleaned;
}

export function hasRecentSignal(signals, symbol, timeframe, maxAgeMs = MAX_AGE_MS) {
  if (!signals || !symbol || !timeframe) return false;
  const key = makeKey(symbol, timeframe);
  const entry = signals[key];
  if (!entry || !entry.sentAt) return false;
  const sentAt = new Date(entry.sentAt).getTime();
  if (!Number.isFinite(sentAt)) return false;
  return Date.now() - sentAt <= maxAgeMs;
}

export function addSignal(signals, symbol, timeframe, data) {
  const result = { ...(signals || {}) };
  const key = makeKey(symbol, timeframe);
  result[key] = {
    sentAt: new Date().toISOString(),
    symbol,
    timeframe,
    direction: data && data.direction ? data.direction : null,
    score: null,
    entry: data && Number.isFinite(data.entry) ? data.entry : null,
    stop: data && Number.isFinite(data.stop) ? data.stop : null
  };
  return result;
}

function createEmptyStats() {
  return {
    lastUpdated: new Date().toISOString(),
    allTime: { total: 0, tp1Hit: 0, tp2Hit: 0, tp3Hit: 0, stopped: 0, active: 0, tp1Rate: 0, tp2Rate: 0, tp3Rate: 0, stopRate: 0 },
    byTimeframe: { "15m": { total: 0, tp1Hit: 0, tp2Hit: 0, tp3Hit: 0, stopped: 0, tp1Rate: 0 } },
    byDirection: { bullish: { total: 0, tp1Hit: 0, tp2Hit: 0, tp3Hit: 0, stopped: 0, tp1Rate: 0 }, bearish: { total: 0, tp1Hit: 0, tp2Hit: 0, tp3Hit: 0, stopped: 0, tp1Rate: 0 } },
    recentSignals: [],
    processedSignals: {}
  };
}

export async function readStats() {
  try {
    await ensureCacheDir();
    const content = await fs.readFile(STATS_FILE, "utf-8");
    const data = JSON.parse(content);
    if (!data || typeof data !== "object") return createEmptyStats();
    if (!data.processedSignals || typeof data.processedSignals !== "object") data.processedSignals = {};
    return data;
  } catch (e) {
    return createEmptyStats();
  }
}

export async function writeStats(data) {
  await ensureCacheDir();
  const payload = {
    ...data,
    lastUpdated: new Date().toISOString()
  };
  await fs.writeFile(STATS_FILE, JSON.stringify(payload, null, 2), "utf-8");
}
