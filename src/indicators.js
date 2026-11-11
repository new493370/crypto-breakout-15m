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

function getConfigNumber(key, fallback, min = 0) {
  const value = Number(CONFIG[key]);
  return Number.isFinite(value) ? Math.max(min, value) : fallback;
}

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

function calculateLocalATR(candles, index) {
  const period = getConfigNumber("ATR_PERIOD", 14, 1);
  if (!Array.isArray(candles) || !Number.isInteger(index) || index < 0 || index >= candles.length) {
    return null;
  }
  const start = index - period + 1;
  if (start < 0) return null;
  let sum = 0;
  for (let i = start; i <= index; i++) {
    if (!isValidCandle(candles[i])) return null;
    const previousClose = i > 0 && isValidCandle(candles[i - 1]) ? cClose(candles[i - 1]) : NaN;
    const tr = getTrueRange(candles[i], previousClose);
    if (!Number.isFinite(tr)) return null;
    sum += tr;
  }
  const atr = sum / period;
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

export function calculateEMA(candles, period) {
  if (!Array.isArray(candles) || !Number.isInteger(period) || period < 1 || candles.length < period) {
    return null;
  }
  const closes = [];
  for (const candle of candles) {
    if (!isValidCandle(candle)) return null;
    closes.push(cClose(candle));
  }
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] - ema) * multiplier + ema;
  }
  return Number.isFinite(ema) ? ema : null;
}

function detectRawPivots(candles, left, right) {
  const highs = [];
  const lows = [];
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
      if (cHigh(candles[j]) >= high) isHigh = false;
      if (cLow(candles[j]) <= low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (!validWindow) continue;
    const pivot = { index: i, confirmed_index: i + right, price: null, type: null };
    if (isHigh) highs.push({ ...pivot, price: high, type: "high" });
    if (isLow) lows.push({ ...pivot, price: low, type: "low" });
  }
  return { highs, lows };
}

function findStructureBreak(candles, candidate, reference, direction) {
  if (!candidate || !reference) return null;
  const startIndex = candidate.confirmed_index + 1;
  const breakBufferAtr = getConfigNumber("STRUCTURE_BREAK_BUFFER_ATR", 0.1);
  const minBodyAtr = getConfigNumber("IMPULSE_MIN_BODY_ATR", 0.8);

  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (!isValidCandle(candle)) continue;
    const atr = calculateLocalATR(candles, i);
    if (!atr) continue;
    const buffer = atr * breakBufferAtr;
    const close = cClose(candle);
    const broken = direction === "bearish" ? close < reference.price - buffer : close > reference.price + buffer;
    if (!broken) continue;
    const bodyAtr = cBody(candle) / atr;
    if (bodyAtr < minBodyAtr) continue;
    return { index: i, candle, level: reference.price };
  }
  return null;
}

function confirmMajorSwings(candles, rawHighs, rawLows) {
  const confirmedHighs = [];
  const confirmedLows = [];

  for (const candidate of rawHighs) {
    const previousLows = rawLows.filter(swing => swing.index < candidate.index);
    if (previousLows.length === 0) continue;
    const reference = previousLows[previousLows.length - 1];
    const structureBreak = findStructureBreak(candles, candidate, reference, "bearish");
    if (!structureBreak) continue;
    confirmedHighs.push({
      ...candidate,
      confirmed_index: structureBreak.index,
      pivot_confirmed_index: candidate.confirmed_index,
      break_index: structureBreak.index,
      break_level: structureBreak.level,
      reference_index: reference.index
    });
  }

  for (const candidate of rawLows) {
    const previousHighs = rawHighs.filter(swing => swing.index < candidate.index);
    if (previousHighs.length === 0) continue;
    const reference = previousHighs[previousHighs.length - 1];
    const structureBreak = findStructureBreak(candles, candidate, reference, "bullish");
    if (!structureBreak) continue;
    confirmedLows.push({
      ...candidate,
      confirmed_index: structureBreak.index,
      pivot_confirmed_index: candidate.confirmed_index,
      break_index: structureBreak.index,
      break_level: structureBreak.level,
      reference_index: reference.index
    });
  }

  function deduplicate(items, type) {
    const groups = new Map();
    for (const item of items) {
      const key = item.break_index;
      if (!groups.has(key)) {
        groups.set(key, item);
        continue;
      }
      const existing = groups.get(key);
      const isMoreExtreme = type === "high" ? item.price > existing.price : item.price < existing.price;
      if (isMoreExtreme) groups.set(key, item);
    }
    return [...groups.values()].sort((a, b) => a.index - b.index);
  }

  return {
    highs: deduplicate(confirmedHighs, "high"),
    lows: deduplicate(confirmedLows, "low")
  };
}

export function detectSwings(candles, left = CONFIG.SWING_LEFT, right = CONFIG.SWING_RIGHT) {
  if (!Array.isArray(candles) || !Number.isInteger(left) || !Number.isInteger(right) || left < 1 || right < 1 || candles.length < left + right + 15) {
    return { highs: [], lows: [] };
  }
  const raw = detectRawPivots(candles, left, right);
  return confirmMajorSwings(candles, raw.highs, raw.lows);
}

export function getLatestMinorSwings(swings, count = 2) {
  if (!swings || !Number.isInteger(count) || count < 1) {
    return { highs: [], lows: [] };
  }
  
  const minDistance = getConfigNumber("MIN_SWING_DISTANCE", 10, 1);
  const maxDistance = getConfigNumber("MAX_SWING_DISTANCE", 50, 1);
  const minPriceGap = getConfigNumber("MIN_SWING_PRICE_GAP_RATIO", 0.005);

  const getValidSwings = (items, type) => {
    const valid = (Array.isArray(items) ? items : [])
      .filter(swing => 
        swing && 
        swing.type === type && 
        Number.isInteger(swing.index) && 
        Number.isFinite(swing.price) && 
        Number.isInteger(swing.confirmed_index) && 
        swing.confirmed_index >= swing.pivot_confirmed_index
      )
      .sort((a, b) => a.index - b.index);

    const result = [];
    for (let i = valid.length - 1; i >= 0; i--) {
      if (result.length === 0) {
        result.unshift(valid[i]);
        continue;
      }
      const lastSelected = result[0];
      const timeGap = lastSelected.index - valid[i].index;
      const priceGap = Math.abs(lastSelected.price - valid[i].price) / valid[i].price;

      if (timeGap >= minDistance && timeGap <= maxDistance && priceGap >= minPriceGap) {
        result.unshift(valid[i]);
      }
      if (result.length === count) break;
    }
    return result;
  };

  return {
    highs: getValidSwings(swings.highs, "high"),
    lows: getValidSwings(swings.lows, "low")
  };
}

export function isValidStructure(swingA, swingB, direction) {
  if (!swingA || !swingB || swingA.type !== swingB.type) return false;
  const minDistance = getConfigNumber("MIN_SWING_DISTANCE", 10, 1);
  const maxDistance = getConfigNumber("MAX_SWING_DISTANCE", 50, 1);
  
  if (swingB.index <= swingA.index) return false;
  const distance = swingB.index - swingA.index;
  if (distance < minDistance || distance > maxDistance) return false;
  if (swingB.confirmed_index <= swingA.confirmed_index) return false;
  if (direction === "bearish" && swingA.type === "high") return swingB.price < swingA.price;
  if (direction === "bullish" && swingA.type === "low") return swingB.price > swingA.price;
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
  if (!trendline || !Number.isFinite(index)) return null;
  const price = trendline.slope * index + trendline.intercept;
  return Number.isFinite(price) ? price : null;
}

export function detectBreakout(candles, trendline, lineDirection, startIndex) {
  if (!Array.isArray(candles) || !trendline || !Number.isInteger(startIndex)) return null;
  const firstIndex = Math.max(1, startIndex);
  const minBodyRatio = getConfigNumber("BREAKOUT_MIN_BODY_RATIO", 0.5);

  for (let i = firstIndex; i < candles.length; i++) {
    const previous = candles[i - 1];
    const candle = candles[i];
    if (!isValidCandle(previous) || !isValidCandle(candle)) continue;

    const previousLine = getTrendlinePrice(trendline, i - 1);
    const currentLine = getTrendlinePrice(trendline, i);
    if (!Number.isFinite(previousLine) || !Number.isFinite(currentLine)) continue;

    let tradeDirection = null;
    if (lineDirection === "bearish" && cClose(previous) <= previousLine && cClose(candle) > currentLine) {
      tradeDirection = "bullish";
    } else if (lineDirection === "bullish" && cClose(previous) >= previousLine && cClose(candle) < currentLine) {
      tradeDirection = "bearish";
    }
    if (!tradeDirection) continue;

    const candleRange = cRange(candle);
    const candleBody = cBody(candle);
    if (candleRange > 0 && (candleBody / candleRange) < minBodyRatio) continue;

    const zoneHigh = cHigh(candle);
    const zoneLow = cLow(candle);
    const zoneWidth = zoneHigh - zoneLow;
    if (!Number.isFinite(zoneWidth) || zoneWidth <= 0) continue;

    return { index: i, direction: tradeDirection, lineDirection, candle, zoneLow, zoneHigh, zoneWidth, linePrice: currentLine };
  }
  return null;
}

export function isPinBar(candle, direction) {
  if (!isValidCandle(candle)) return false;
  const range = cRange(candle);
  if (range <= 0) return false;
  const body = cBody(candle);
  const bodyRatio = getConfigNumber("PINBAR_BODY_RATIO", 0.3);
  if (body / range > bodyRatio) return false;
  const upperWick = cHigh(candle) - Math.max(cOpen(candle), cClose(candle));
  const lowerWick = Math.min(cOpen(candle), cClose(candle)) - cLow(candle);
  if (direction === "bearish") return upperWick > body * 2;
  if (direction === "bullish") return lowerWick > body * 2;
  return false;
}

export function isEngulfing(prevCandle, currCandle, direction) {
  if (!isValidCandle(prevCandle) || !isValidCandle(currCandle)) return false;
  const currBody = cBody(currCandle);
  const currRange = cRange(currCandle);
  if (currRange <= 0) return false;
  const bodyRatio = getConfigNumber("ENGULFING_BODY_RATIO", 0.95);
  if (currBody / currRange < bodyRatio) return false;
  const prevTop = Math.max(cOpen(prevCandle), cClose(prevCandle));
  const prevBottom = Math.min(cOpen(prevCandle), cClose(prevCandle));
  const currTop = Math.max(cOpen(currCandle), cClose(currCandle));
  const currBottom = Math.min(cOpen(currCandle), cClose(currCandle));
  if (direction === "bearish") return isBear(prevCandle) && isBear(currCandle) && currTop >= prevTop && currBottom <= prevBottom;
  if (direction === "bullish") return isBull(prevCandle) && isBull(currCandle) && currTop >= prevTop && currBottom <= prevBottom;
  return false;
}
