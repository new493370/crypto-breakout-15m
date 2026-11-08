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

  if (!candles || candles.length < left + right + 1) {
    return { highs, lows };
  }

  for (let i = left; i < candles.length - right; i++) {
    const ch = cHigh(candles[i]);
    const cl = cLow(candles[i]);

    let isHigh = true;
    let isLow = true;

    for (let j = i - left; j < i; j++) {
      if (cHigh(candles[j]) >= ch) isHigh = false;
      if (cLow(candles[j]) <= cl) isLow = false;
    }

    for (let j = i + 1; j <= i + right; j++) {
      if (cHigh(candles[j]) >= ch) isHigh = false;
      if (cLow(candles[j]) <= cl) isLow = false;
    }

    if (isHigh) highs.push({ index: i, price: ch, confirmed_index: i + right, type: "high" });
    if (isLow) lows.push({ index: i, price: cl, confirmed_index: i + right, type: "low" });
  }

  return { highs, lows };
}

export function getLatestMinorSwings(swings, count = 2) {
  const h = (swings.highs || []).slice(-count);
  const l = (swings.lows || []).slice(-count);
  return {
    highs: h,
    lows: l
  };
}

export function isValidStructure(swingA, swingB, direction) {
  if (!swingA || !swingB) return false;
  if (Math.abs(swingB.index - swingA.index) < CONFIG.MIN_SWING_DISTANCE) return false;

  if (direction === "bearish") {
    if (swingA.type === "high" && swingB.type === "high") {
      if (swingB.price <= swingA.price) return true;
    }
  } else if (direction === "bullish") {
    if (swingA.type === "low" && swingB.type === "low") {
      if (swingB.price >= swingA.price) return true;
    }
  }
  return false;
}

export function calculateTrendline(swingA, swingB) {
  const slope = (swingB.price - swingA.price) / (swingB.index - swingA.index);
  const intercept = swingA.price - slope * swingA.index;
  return { slope, intercept };
}

export function getTrendlinePrice(trendline, index) {
  return trendline.slope * index + trendline.intercept;
}

export function detectBreakout(candles, trendline, direction, startIndex) {
  if (!candles || !trendline) return null;

  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];
    const linePrice = getTrendlinePrice(trendline, i);

    if (direction === "bullish") {
      if (isBull(candle) && cClose(candle) > linePrice && cOpen(candle) <= linePrice) {
        const zoneHigh = cHigh(candle);
        const zoneLow = cLow(candle);
        const zoneWidth = zoneHigh - zoneLow;
        if (zoneWidth <= 0) continue;

        return {
          index: i,
          direction: "bullish",
          candle,
          zoneLow,
          zoneHigh,
          zoneWidth,
          linePrice
        };
      }
    } else {
      if (isBear(candle) && cClose(candle) < linePrice && cOpen(candle) >= linePrice) {
        const zoneHigh = cHigh(candle);
        const zoneLow = cLow(candle);
        const zoneWidth = zoneHigh - zoneLow;
        if (zoneWidth <= 0) continue;

        return {
          index: i,
          direction: "bearish",
          candle,
          zoneLow,
          zoneHigh,
          zoneWidth,
          linePrice
        };
      }
    }
  }

  return null;
}

export function detectEngulfing(candles, direction, startIndex, maxBars, zoneLow, zoneHigh) {
  if (!candles || startIndex < 1) return null;

  const endIndex = Math.min(candles.length - 1, startIndex + maxBars);

  for (let i = startIndex + 1; i <= endIndex; i++) {
    const c = candles[i];
    const prev = candles[i - 1];

    if (!prev || !c) continue;

    const cRange = cRange(c);
    const prevRange = cRange(prev);
    if (cRange <= 0 || prevRange <= 0) continue;

    const touchedZone = 
      (cLow(c) <= zoneHigh && cHigh(c) >= zoneLow) || 
      (cLow(c) >= zoneLow && cLow(c) <= zoneHigh) ||
      (cHigh(c) >= zoneLow && cHigh(c) <= zoneHigh);

    if (!touchedZone) continue;

    if (direction === "bullish") {
      if (
        isBull(c) &&
        isBear(prev) &&
        cClose(c) > cHigh(prev) &&
        cOpen(c) <= cLow(prev)
      ) {
        return { index: i, candle: c, entryPrice: cClose(c) };
      }
    } else if (direction === "bearish") {
      if (
        isBear(c) &&
        isBull(prev) &&
        cClose(c) < cLow(prev) &&
        cOpen(c) >= cHigh(prev)
      ) {
        return { index: i, candle: c, entryPrice: cClose(c) };
      }
    }
  }

  return null;
}
