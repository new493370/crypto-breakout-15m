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
  const highs = [];
  const lows = [];

  if (!Array.isArray(candles) || candles.length < left + right + 1) {
    return { highs, lows };
  }

  for (let i = left; i < candles.length - right; i++) {
    const high = cHigh(candles[i]);
    const low = cLow(candles[i]);

    let isHigh = true;
    let isLow = true;

    for (let j = i - left; j < i; j++) {
      if (cHigh(candles[j]) >= high) isHigh = false;
      if (cLow(candles[j]) <= low) isLow = false;
    }

    for (let j = i + 1; j <= i + right; j++) {
      if (cHigh(candles[j]) >= high) isHigh = false;
      if (cLow(candles[j]) <= low) isLow = false;
    }

    if (isHigh) {
      highs.push({
        index: i,
        price: high,
        confirmed_index: i + right,
        type: "high"
      });
    }

    if (isLow) {
      lows.push({
        index: i,
        price: low,
        confirmed_index: i + right,
        type: "low"
      });
    }
  }

  return { highs, lows };
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

    const bodyTop = Math.max(cOpen(candle), cClose(candle));
    const bodyBottom = Math.min(cOpen(candle), cClose(candle));

    const zoneHigh = bodyTop;
    const zoneLow = bodyBottom;
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
    if (!candle || candle.incomplete) continue;

    const touchedZone = cLow(candle) <= zoneHigh && cHigh(candle) >= zoneLow;
    if (touchedZone) {
      return {
        index: i,
        candle,
        entryPrice: (zoneHigh + zoneLow) / 2
      };
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
