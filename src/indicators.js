
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

function isValidCandle(c) {
  if (!c || c.incomplete) return false;

  const high = cHigh(c);
  const low = cLow(c);
  const open = cOpen(c);
  const close = cClose(c);

  return (
    Number.isFinite(high) &&
    Number.isFinite(low) &&
    Number.isFinite(open) &&
    Number.isFinite(close) &&
    high >= low &&
    high >= Math.max(open, close) &&
    low <= Math.min(open, close)
  );
}

function getTrueRange(candle, previousClose) {
  const range = cRange(candle);

  if (!Number.isFinite(previousClose)) return range;

  return Math.max(
    range,
    Math.abs(cHigh(candle) - previousClose),
    Math.abs(cLow(candle) - previousClose)
  );
}

function calculateLocalATR(candles, index, period = 14) {
  const start = Math.max(0, index - period + 1);
  const ranges = [];

  for (let i = start; i <= index; i++) {
    if (!isValidCandle(candles[i])) return null;

    const previousClose =
      i > 0 && isValidCandle(candles[i - 1])
        ? cClose(candles[i - 1])
        : NaN;

    const trueRange = getTrueRange(candles[i], previousClose);

    if (!Number.isFinite(trueRange)) return null;

    ranges.push(trueRange);
  }

  if (ranges.length < period) return null;

  const atr = ranges.reduce((sum, value) => sum + value, 0) / ranges.length;

  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

function getSwingProminence(candles, index, left, right, type) {
  const current = candles[index];

  if (!isValidCandle(current)) return 0;

  if (type === "high") {
    let leftLowest = Infinity;
    let rightLowest = Infinity;

    for (let i = index - left; i < index; i++) {
      if (!isValidCandle(candles[i])) return 0;
      leftLowest = Math.min(leftLowest, cLow(candles[i]));
    }

    for (let i = index + 1; i <= index + right; i++) {
      if (!isValidCandle(candles[i])) return 0;
      rightLowest = Math.min(rightLowest, cLow(candles[i]));
    }

    if (
      !Number.isFinite(leftLowest) ||
      !Number.isFinite(rightLowest)
    ) {
      return 0;
    }

    const leftRetracement = cHigh(current) - leftLowest;
    const rightRetracement = cHigh(current) - rightLowest;

    return Math.min(leftRetracement, rightRetracement);
  }

  if (type === "low") {
    let leftHighest = -Infinity;
    let rightHighest = -Infinity;

    for (let i = index - left; i < index; i++) {
      if (!isValidCandle(candles[i])) return 0;
      leftHighest = Math.max(leftHighest, cHigh(candles[i]));
    }

    for (let i = index + 1; i <= index + right; i++) {
      if (!isValidCandle(candles[i])) return 0;
      rightHighest = Math.max(rightHighest, cHigh(candles[i]));
    }

    if (
      !Number.isFinite(leftHighest) ||
      !Number.isFinite(rightHighest)
    ) {
      return 0;
    }

    const leftRetracement = leftHighest - cLow(current);
    const rightRetracement = rightHighest - cLow(current);

    return Math.min(leftRetracement, rightRetracement);
  }

  return 0;
}

function isSignificantSwing(candles, index, left, right, type) {
  const minSwingAtr = Number.isFinite(CONFIG.MIN_SWING_ATR)
    ? Math.max(0, CONFIG.MIN_SWING_ATR)
    : 0.35;

  if (minSwingAtr === 0) return true;

  const atr = calculateLocalATR(candles, index, 14);

  if (!atr) return false;

  const prominence = getSwingProminence(
    candles,
    index,
    left,
    right,
    type
  );

  return prominence >= atr * minSwingAtr;
}

export function detectSwings(
  candles,
  left = CONFIG.SWING_LEFT,
  right = CONFIG.SWING_RIGHT
) {
  const highs = [];
  const lows = [];

  if (
    !Array.isArray(candles) ||
    !Number.isInteger(left) ||
    !Number.isInteger(right) ||
    left < 1 ||
    right < 1 ||
    candles.length < left + right + 1
  ) {
    return { highs, lows };
  }

  for (let i = left; i < candles.length - right; i++) {
    const current = candles[i];

    if (!isValidCandle(current)) continue;

    const high = cHigh(current);
    const low = cLow(current);

    let isHigh = true;
    let isLow = true;
    let validWindow = true;

    for (let j = i - left; j <= i + right; j++) {
      if (!isValidCandle(candles[j])) {
        validWindow = false;
        break;
      }

      if (j === i) continue;

      if (cHigh(candles[j]) >= high) {
        isHigh = false;
      }

      if (cLow(candles[j]) <= low) {
        isLow = false;
      }

      if (!isHigh && !isLow) break;
    }

    if (!validWindow) continue;

    const confirmedIndex = i + right;

    if (
      isHigh &&
      isSignificantSwing(candles, i, left, right, "high")
    ) {
      highs.push({
        index: i,
        price: high,
        confirmed_index: confirmedIndex,
        type: "high"
      });
    }

    if (
      isLow &&
      isSignificantSwing(candles, i, left, right, "low")
    ) {
      lows.push({
        index: i,
        price: low,
        confirmed_index: confirmedIndex,
        type: "low"
      });
    }
  }

  return { highs, lows };
}

export function getLatestMinorSwings(swings, count = 2) {
  if (!swings || !Number.isInteger(count) || count < 1) {
    return { highs: [], lows: [] };
  }

  const getValidSwings = (items, type) => {
    return (Array.isArray(items) ? items : [])
      .filter(swing =>
        swing &&
        swing.type === type &&
        Number.isInteger(swing.index) &&
        Number.isFinite(swing.price) &&
        Number.isInteger(swing.confirmed_index) &&
        swing.confirmed_index >= swing.index
      )
      .sort((a, b) => a.index - b.index)
      .slice(-count);
  };

  return {
    highs: getValidSwings(swings.highs, "high"),
    lows: getValidSwings(swings.lows, "low")
  };
}

export function isValidStructure(swingA, swingB, direction) {
  if (!swingA || !swingB) return false;

  if (swingA.type !== swingB.type) return false;

  if (
    !Number.isInteger(swingA.index) ||
    !Number.isInteger(swingB.index) ||
    !Number.isFinite(swingA.price) ||
    !Number.isFinite(swingB.price)
  ) {
    return false;
  }

  if (swingB.index <= swingA.index) return false;

  if (swingB.index - swingA.index < CONFIG.MIN_SWING_DISTANCE) {
    return false;
  }

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

  const slope = (swingB.price - swingA.price) /
    (swingB.index - swingA.index);

  const intercept = swingA.price - slope * swingA.index;

  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) {
    return null;
  }

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

export function detectFirstPullback(
  candles,
  direction,
  startIndex,
  maxBars,
  zoneLow,
  zoneHigh
) {
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
