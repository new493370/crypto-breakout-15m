import { CONFIG } from "./config.js";
import { getKlines } from "./exchanges.js";

export async function updateSignalStatus(signal) {
  const currentStatus = signal?.status || "active";

  if (currentStatus === "tp1_hit" || currentStatus === "stopped") {
    return { status: currentStatus, events: [], exitPrice: signal.exitPrice ?? null };
  }

  try {
    const {
      symbol,
      timeframe,
      direction,
      entry,
      stop,
      tp1,
      signalCandleTime
    } = signal;

    if (
      !symbol ||
      !timeframe ||
      !Number.isFinite(entry) ||
      !Number.isFinite(stop) ||
      !Number.isFinite(tp1) ||
      !Number.isFinite(signalCandleTime)
    ) {
      return { status: currentStatus, events: [], exitPrice: null };
    }

    const candles = await getKlines(symbol, timeframe, CONFIG.KLINE_LIMIT);

    if (!Array.isArray(candles) || candles.length === 0) {
      return { status: currentStatus, events: [], exitPrice: null };
    }

    const isBullish = direction === "bullish";
    const isBearish = direction === "bearish";

    if (!isBullish && !isBearish) {
      return { status: currentStatus, events: [], exitPrice: null };
    }

    const signalCandles = candles.filter(c =>
      c &&
      c.incomplete !== true &&
      Number.isFinite(c.time) &&
      c.time > signalCandleTime
    );

    for (let i = 0; i < signalCandles.length; i++) {
      const candle = signalCandles[i];

      const stopHit = isBullish
        ? candle.low <= stop
        : candle.high >= stop;

      const targetHit = isBullish
        ? candle.high >= tp1
        : candle.low <= tp1;

      if (stopHit) {
        return {
          status: "stopped",
          events: [{ type: "stopped", index: i }],
          exitPrice: stop
        };
      }

      if (targetHit) {
        return {
          status: "tp1_hit",
          events: [{ type: "tp1_hit", index: i }],
          exitPrice: tp1
        };
      }
    }

    return {
      status: currentStatus,
      events: [],
      exitPrice: null
    };
  } catch (e) {
    return {
      status: currentStatus,
      events: [],
      exitPrice: null
    };
  }
}

export function computeStats(recentSignals) {
  const allTime = {
    total: 0,
    tp1Hit: 0,
    tp2Hit: 0,
    tp3Hit: 0,
    stopped: 0,
    active: 0,
    tp1Rate: 0,
    tp2Rate: 0,
    tp3Rate: 0,
    stopRate: 0
  };

  const byDirection = {
    bullish: { total: 0, tp1Hit: 0, tp2Hit: 0, tp3Hit: 0, stopped: 0, tp1Rate: 0 },
    bearish: { total: 0, tp1Hit: 0, tp2Hit: 0, tp3Hit: 0, stopped: 0, tp1Rate: 0 }
  };

  for (const signal of recentSignals || []) {
    if (!signal) continue;

    const status = signal.status || "active";
    const direction = signal.direction;

    allTime.total++;

    if (status === "tp1_hit") allTime.tp1Hit++;
    else if (status === "stopped") allTime.stopped++;
    else allTime.active++;

    if (byDirection[direction]) {
      const item = byDirection[direction];
      item.total++;

      if (status === "tp1_hit") item.tp1Hit++;
      else if (status === "stopped") item.stopped++;
    }
  }

  const finished = allTime.tp1Hit + allTime.stopped;

  if (finished > 0) {
    allTime.tp1Rate = Math.round((allTime.tp1Hit / finished) * 1000) / 10;
    allTime.stopRate = Math.round((allTime.stopped / finished) * 1000) / 10;
  }

  for (const direction of Object.keys(byDirection)) {
    const item = byDirection[direction];
    const completed = item.tp1Hit + item.stopped;

    if (completed > 0) {
      item.tp1Rate = Math.round((item.tp1Hit / completed) * 1000) / 10;
    }
  }

  return { allTime, byDirection };
}
