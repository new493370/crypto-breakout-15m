import { analyze } from "./analysis.js";

export async function updateSignalStatus(signal) {
  try {
    const analysis = await analyze(signal.symbol);

    if (!analysis || !Number.isFinite(analysis.current_price)) {
      return { status: signal.status || "active", events: [], exitPrice: null };
    }

    const price = analysis.current_price;
    const { direction, entry, stop, tp1 } = signal;

    if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(tp1)) {
      return { status: signal.status || "active", events: [], exitPrice: null };
    }

    const risk = Math.abs(entry - stop);
    if (risk <= 0) {
      return { status: signal.status || "active", events: [], exitPrice: null };
    }

    const isBull = direction === "bullish";
    let isActivated = signal.activated === true;

    if (!isActivated) {
      if (isBull) isActivated = price <= entry;
      else isActivated = price >= entry;
    }

    if (!isActivated) {
      return { status: "pending", events: [], exitPrice: null };
    }

    const sentTime = signal.sentAt ? new Date(signal.sentAt).getTime() : 0;
    const allCandles = Array.isArray(analysis._candles) ? analysis._candles : [];
    const signalCandles = allCandles.filter(c => c && c.time >= sentTime && !c.incomplete).slice(-200);

    if (signalCandles.length === 0) {
      return { status: signal.status || "active", events: [], exitPrice: null };
    }

    let stopHit = false;
    let tp1Hit = false;
    let stopIndex = -1;
    let tp1Index = -1;
    let exitPrice = null;

    for (let i = 0; i < signalCandles.length; i++) {
      const candle = signalCandles[i];

      if (isBull) {
        if (Number.isFinite(candle.low) && candle.low <= stop && stopIndex === -1) {
          stopHit = true;
          stopIndex = i;
          exitPrice = stop;
          break;
        }
        if (Number.isFinite(candle.high) && candle.high >= tp1 && tp1Index === -1) {
          tp1Hit = true;
          tp1Index = i;
        }
      } else {
        if (Number.isFinite(candle.high) && candle.high >= stop && stopIndex === -1) {
          stopHit = true;
          stopIndex = i;
          exitPrice = stop;
          break;
        }
        if (Number.isFinite(candle.low) && candle.low <= tp1 && tp1Index === -1) {
          tp1Hit = true;
          tp1Index = i;
        }
      }
    }

    if (stopIndex === -1) {
      if (isBull) {
        if (price <= stop) { stopHit = true; stopIndex = signalCandles.length; exitPrice = stop; }
      } else {
        if (price >= stop) { stopHit = true; stopIndex = signalCandles.length; exitPrice = stop; }
      }
    }

    if (stopIndex === -1 && tp1Index === -1) {
      if (isBull) {
        if (price >= tp1) { tp1Hit = true; tp1Index = signalCandles.length; }
      } else {
        if (price <= tp1) { tp1Hit = true; tp1Index = signalCandles.length; }
      }
    }

    const events = [];
    if (tp1Hit) events.push({ type: "tp1_hit", index: tp1Index });
    if (stopHit) events.push({ type: "stopped", index: stopIndex });
    events.sort((a, b) => a.index - b.index);

    let finalStatus = signal.status || "active";
    if (events.length > 0) {
      finalStatus = events[events.length - 1].type;
    }

    return { status: finalStatus, events, exitPrice };
  } catch (e) {
    return { status: signal.status || "active", events: [], exitPrice: null };
  }
}

export function computeStats(recentSignals) {
  const allTime = { total: 0, tp1Hit: 0, stopped: 0, active: 0, tp1Rate: 0, stopRate: 0 };
  const byDirection = {
    bullish: { total: 0, tp1Hit: 0, stopped: 0, tp1Rate: 0 },
    bearish: { total: 0, tp1Hit: 0, stopped: 0, tp1Rate: 0 }
  };

  for (const s of recentSignals || []) {
    if (!s) continue;
    const status = s.status || "active";
    const dir = s.direction;

    allTime.total++;
    if (status === "tp1_hit") allTime.tp1Hit++;
    else if (status === "stopped") allTime.stopped++;
    else allTime.active++;

    if (byDirection[dir]) {
      byDirection[dir].total++;
      if (status === "tp1_hit") byDirection[dir].tp1Hit++;
      else if (status === "stopped") byDirection[dir].stopped++;
    }
  }

  const finished = allTime.total - allTime.active;
  if (finished > 0) {
    allTime.tp1Rate = Math.round((allTime.tp1Hit / finished) * 1000) / 10;
    allTime.stopRate = Math.round((allTime.stopped / finished) * 1000) / 10;
  }

  for (const dir of Object.keys(byDirection)) {
    const d = byDirection[dir];
    const done = d.tp1Hit + d.stopped;
    if (done > 0) d.tp1Rate = Math.round((d.tp1Hit / done) * 1000) / 10;
  }

  return { allTime, byDirection };
}
