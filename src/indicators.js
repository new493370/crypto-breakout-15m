import { CONFIG } from "./config.js";

export function cHigh(c) { return c.high; }
export function cLow(c) { return c.low; }
export function cOpen(c) { return c.open; }
export function cClose(c) { return c.close; }
export function cVol(c) { return c.volume || 0; }
export function cRange(c) { return Math.max(cHigh(c) - cLow(c), 0); }
export function cBody(c) { return Math.abs(cClose(c) - cOpen(c)); }
export function isBull(c) { return cClose(c) > cOpen(c); }
export function isBear(c) { return cClose(c) < cOpen(c); }

export function detectSwings(candles, left = CONFIG.SWING_LEFT, right = CONFIG.SWING_RIGHT) {
  const rawHighs = [];
  const rawLows = [];

  if (!Array.isArray(candles) || candles.length < left + right + 1) {
    return { highs: [], lows: [] };
  }

  for (let i = left; i < candles.length - right; i++) {
    const bodyHigh = Math.max(cOpen(candles[i]), cClose(candles[i]));
    const bodyLow = Math.min(cOpen(candles[i]), cClose(candles[i]));

    let isHigh = true;
    let isLow = true;

    for (let j = i - left; j < i; j++) {
      const prevBodyHigh = Math.max(cOpen(candles[j]), cClose(candles[j]));
      const prevBodyLow = Math.min(cOpen(candles[j]), cClose(candles[j]));
      if (prevBodyHigh >= bodyHigh) isHigh = false;
      if (prevBodyLow <= bodyLow) isLow = false;
    }

    for (let j = i + 1; j <= i + right; j++) {
      const nextBodyHigh = Math.max(cOpen(candles[j]), cClose(candles[j]));
      const nextBodyLow = Math.min(cOpen(candles[j]), cClose(candles[j]));
      if (nextBodyHigh >= bodyHigh) isHigh = false;
      if (nextBodyLow <= bodyLow) isLow = false;
    }

    if (isHigh) {
      rawHighs.push({ index: i, price: bodyHigh, confirmed_index: i + right, type: "high" });
    }
    if (isLow) {
      rawLows.push({ index: i, price: bodyLow, confirmed_index: i + right, type: "low" });
    }
  }

  const merged = [...rawHighs, ...rawLows].sort((a, b) => a.index - b.index);
  const filtered = [];

  for (const current of merged) {
    if (filtered.length === 0) {
      filtered.push(current);
      continue;
    }

    const last = filtered[filtered.length - 1];

    if (last.type === current.type) {
      if (current.type === "high" && current.price > last.price) {
        filtered[filtered.length - 1] = current;
      } else if (current.type === "low" && current.price < last.price) {
        filtered[filtered.length - 1] = current;
      }
      continue;
    }

    const priceDiffPercent = (Math.abs(current.price - last.price) / last.price) * 100;
    const isTimeValid = Math.abs(current.index - last.index) >= CONFIG.MIN_CANDLES_BETWEEN_PIVOTS;
    const isPriceValid = priceDiffPercent >= CONFIG.MIN_LEVEL_DIFF_PERCENT;

    if (isTimeValid && isPriceValid) {
      filtered.push(current);
    } else if (last.type === "high" && current.type === "low" && current.price < last.price) {
      filtered[filtered.length - 1] = current;
    } else if (last.type === "low" && current.type === "high" && current.price > last.price) {
      filtered[filtered.length - 1] = current;
    }
  }

  return {
    highs: filtered.filter(s => s.type === "high"),
    lows: filtered.filter(s => s.type === "low")
  };
}

export function getLatestMinorSwings(swings, count = 2) {
  return {
    highs: (swings.highs || []).slice(-count),
    lows: (swings.lows || []).slice(-count)
  };
}

export function isValidStructure(swingA, swingB, direction) {
  if (!swingA || !swingB) return false;
  if (swingA.type !== swingB.type) return false;
  if (Math.abs(swingB.index - swingA.index) < CONFIG.MIN_SWING_DISTANCE) return false;

  const priceDiffPercent = (Math.abs(swingB.price - swingA.price) / swingA.price) * 100;
  if (priceDiffPercent < CONFIG.MIN_LEVEL_DIFF_PERCENT) return false;

  if (direction === "bearish" && swingA.type === "high") {
    return swingB.price < swingA.price;
  }

  if (direction === "bullish" && swingA.type === "low") {
    return swingB.price > swingA.price;
  }

  return false;
}

export function calculateTrendline(swingA, swingB) {
  if (!swingA || !swingB || swingB.index === swingA.index) return null;

  const slope = (swingB.price - swingA.price) / (swingB.index - swingA.index);
  const intercept = swingA.price - slope * swingA.index;

  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return null;

  return { slope, intercept };
}

export function getTrendlinePrice(trendline, index) {
  return trendline.slope * index + trendline.intercept;
}

export function detectBreakout(candles, trendline, lineDirection, startIndex) {
  if (!Array.isArray(candles) || !trendline) return null;

  const firstIndex = Math.max(1, startIndex);

  for (let i = firstIndex; i < candles.length; i++) {
    const previous = candles[i - 1];
    const candle = candles[i];

    if (!previous || !candle || candle.incomplete || previous.incomplete) continue;

    const previousLine = getTrendlinePrice(trendline, i - 1);
    const currentLine = getTrendlinePrice(trendline, i);

    let tradeDirection = null;

    if (lineDirection === "bearish") {
      if (cClose(previous) <= previousLine && cClose(candle) > currentLine) {
        tradeDirection = "bullish";
      }
    } else if (lineDirection === "bullish") {
      if (cClose(previous) >= previousLine && cClose(candle) < currentLine) {
        tradeDirection = "bearish";
      }
    }

    if (!tradeDirection) continue;

    const zoneHigh = cHigh(candle);
    const zoneLow = cLow(candle);
    const zoneWidth = zoneHigh - zoneLow;

    if (!Number.isFinite(zoneWidth) || zoneWidth <= 0) continue;

    return {
      index: i,
      direction: tradeDirection,
      lineDirection,
      candle,
      zoneLow,
      zoneHigh,
      zoneWidth,
      linePrice: currentLine
    };
  }

  return null;
}

export function detectFirstPullback(candles, direction, startIndex, maxBars, zoneLow, zoneHigh) {
  if (!Array.isArray(candles) || startIndex < 0) return null;

  const endIndex = Math.min(candles.length - 1, startIndex + maxBars);

  for (let i = startIndex + 1; i <= endIndex; i++) {
    const candle = candles[i];
    const previous = candles[i - 1];

    if (!candle || candle.incomplete || !previous || previous.incomplete) continue;

    const touchedZone = cLow(candle) <= zoneHigh && cHigh(candle) >= zoneLow;
    if (!touchedZone) continue;

    const bodyTop = Math.max(cOpen(candle), cClose(candle));
    const bodyBottom = Math.min(cOpen(candle), cClose(candle));
    const prevBodyTop = Math.max(cOpen(previous), cClose(previous));
    const prevBodyBottom = Math.min(cOpen(previous), cClose(previous));

    if (direction === "bullish") {
      const isBullishCandle = cClose(candle) > cOpen(candle);
      const isPrevBearish = cClose(previous) < cOpen(previous);
      const isEngulfing = isBullishCandle && isPrevBearish && bodyTop >= prevBodyTop && bodyBottom <= prevBodyBottom;

      if (isEngulfing) {
        return {
          index: i,
          candle,
          entryPrice: (zoneHigh + zoneLow) / 2
        };
      }
    } else if (direction === "bearish") {
      const isBearishCandle = cClose(candle) < cOpen(candle);
      const isPrevBullish = cClose(previous) > cOpen(previous);
      const isEngulfing = isBearishCandle && isPrevBullish && bodyTop >= prevBodyTop && bodyBottom <= prevBodyBottom;

      if (isEngulfing) {
        return {
          index: i,
          candle,
          entryPrice: (zoneHigh + zoneLow) / 2
        };
      }
    }
  }

  return null;
}

export function calculateEMA(candles, period = 50) {
  if (!Array.isArray(candles) || candles.length < period) return null;

  const closes = candles.map(c => cClose(c));
  const multiplier = 2 / (period + 1);

  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] - ema) * multiplier + ema;
  }

  return ema;
}
