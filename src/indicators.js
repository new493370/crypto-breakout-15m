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

  if (
    !Array.isArray(candles) ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= candles.length
  ) {
    return null;
  }

  const start = index - period + 1;
  if (start < 0) return null;

  let sum = 0;

  for (let i = start; i <= index; i++) {
    if (!isValidCandle(candles[i])) return null;

    const previousClose =
      i > 0 && isValidCandle(candles[i - 1])
        ? cClose(candles[i - 1])
        : NaN;

    const tr = getTrueRange(candles[i], previousClose);
    if (!Number.isFinite(tr)) return null;

    sum += tr;
  }

  const atr = sum / period;
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

    return Math.min(
      cHigh(current) - leftLowest,
      cHigh(current) - rightLowest
    );
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

    return Math.min(
      leftHighest - cLow(current),
      rightHighest - cLow(current)
    );
  }

  return 0;
}

function isSignificantSwing(candles, index, left, right, type) {
  const minSwingAtr = getConfigNumber("MIN_SWING_ATR", 0.35);
  if (minSwingAtr === 0) return true;

  const atr = calculateLocalATR(candles, index);
  if (!atr) return false;

  const prominence = getSwingProminence(candles, index, left, right, type);
  return prominence >= atr * minSwingAtr;
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

    const pivot = {
      index: i,
      confirmed_index: i + right,
      price: null,
      type: null
    };

    if (isHigh && isSignificantSwing(candles, i, left, right, "high")) {
      highs.push({ ...pivot, price: high, type: "high" });
    }

    if (isLow && isSignificantSwing(candles, i, left, right, "low")) {
      lows.push({ ...pivot, price: low, type: "low" });
    }
  }

  return { highs, lows };
}

function findStructureBreak(candles, candidate, reference, direction) {
  if (!candidate || !reference) return null;

  const startIndex = candidate.confirmed_index + 1;
  const minBodyAtr = getConfigNumber("IMPULSE_MIN_BODY_ATR", 0.8);

  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (!isValidCandle(candle)) continue;

    const close = cClose(candle);
    const broken = direction === "bearish"
      ? close < reference.price
      : close > reference.price;

    if (!broken) continue;

    const atr = calculateLocalATR(candles, i);
    if (atr) {
      const bodyAtr = cBody(candle) / atr;
      if (bodyAtr < minBodyAtr) continue;
    }

    return { index: i, candle, level: reference.price };
  }

  return null;
}

function calculateDisplacementScore(candles, breakIndex, direction) {
  const candle = candles[breakIndex];
  if (!isValidCandle(candle)) {
    return { displacement: false, displacement_atr: 0, score: 70 };
  }

  const atr = calculateLocalATR(candles, breakIndex);
  if (!atr) {
    return { displacement: false, displacement_atr: 0, score: 70 };
  }

  const body = cBody(candle);
  const bodyAtr = body / atr;
  const range = cRange(candle);

  const closePosition = range > 0
    ? direction === "bearish"
      ? (cHigh(candle) - cClose(candle)) / range
      : (cClose(candle) - cLow(candle)) / range
    : 0;

  const minBodyAtr = getConfigNumber("DISPLACEMENT_MIN_BODY_ATR", 0.8);
  const minClosePosition = getConfigNumber("DISPLACEMENT_CLOSE_POSITION", 0.65, 0.5);

  const hasDisplacement =
    bodyAtr >= minBodyAtr &&
    closePosition >= minClosePosition &&
    (direction === "bearish" ? isBear(candle) : isBull(candle));

  const bodyScore = Math.min(bodyAtr / Math.max(minBodyAtr, 0.01), 1);
  const closeScore = Math.min(closePosition / Math.max(minClosePosition, 0.01), 1);
  const score = Math.round(70 + (bodyScore * 15) + (closeScore * 15));

  return {
    displacement: hasDisplacement,
    displacement_atr: Number(bodyAtr.toFixed(2)),
    score: Math.min(100, score)
  };
}

function confirmMinorSwings(candles, rawHighs, rawLows) {
  const confirmedHighs = [];
  const confirmedLows = [];

  for (const candidate of rawHighs) {
    const previousLows = rawLows.filter(swing => swing.index < candidate.index);
    if (previousLows.length === 0) continue;

    const reference = previousLows[previousLows.length - 1];
    const structureBreak = findStructureBreak(candles, candidate, reference, "bearish");
    if (!structureBreak) continue;

    const quality = calculateDisplacementScore(candles, structureBreak.index, "bearish");

    confirmedHighs.push({
      ...candidate,
      confirmed_index: structureBreak.index,
      pivot_confirmed_index: candidate.confirmed_index,
      break_index: structureBreak.index,
      break_level: structureBreak.level,
      reference_index: reference.index,
      displacement: quality.displacement,
      displacement_atr: quality.displacement_atr,
      score: quality.score
    });
  }

  for (const candidate of rawLows) {
    const previousHighs = rawHighs.filter(swing => swing.index < candidate.index);
    if (previousHighs.length === 0) continue;

    const reference = previousHighs[previousHighs.length - 1];
    const structureBreak = findStructureBreak(candles, candidate, reference, "bullish");
    if (!structureBreak) continue;

    const quality = calculateDisplacementScore(candles, structureBreak.index, "bullish");

    confirmedLows.push({
      ...candidate,
      confirmed_index: structureBreak.index,
      pivot_confirmed_index: candidate.confirmed_index,
      break_index: structureBreak.index,
      break_level: structureBreak.level,
      reference_index: reference.index,
      displacement: quality.displacement,
      displacement_atr: quality.displacement_atr,
      score: quality.score
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
      const isMoreExtreme = type === "high"
        ? item.price > existing.price
        : item.price < existing.price;

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
  if (
    !Array.isArray(candles) ||
    !Number.isInteger(left) ||
    !Number.isInteger(right) ||
    left < 1 ||
    right < 1 ||
    candles.length < left + right + 15
  ) {
    return { highs: [], lows: [] };
  }

  const raw = detectRawPivots(candles, left, right);
  return confirmMinorSwings(candles, raw.highs, raw.lows);
}

export function getLatestMinorSwings(swings, count = 2) {
  if (!swings || !Number.isInteger(count) || count < 1) {
    return { highs: [], lows: [] };
  }

  const minDistance = getConfigNumber("MIN_SWING_DISTANCE", 10, 1);

  const getValidSwings = (items, type) => {
    const valid = (Array.isArray(items) ? items : [])
      .filter(swing =>
        swing &&
        swing.type === type &&
        Number.isInteger(swing.index) &&
        Number.isFinite(swing.price) &&
        Number.isInteger(swing.confirmed_index) &&
        Number.isInteger(swing.pivot_confirmed_index) &&
        swing.confirmed_index >= swing.pivot_confirmed_index &&
        swing.break_index === swing.confirmed_index &&
        Number.isFinite(swing.score)
      )
      .sort((a, b) => a.index - b.index);

    const result = [];
    for (let i = valid.length - 1; i >= 0; i--) {
      if (result.length === 0) {
        result.unshift(valid[i]);
        continue;
      }
      const lastSelected = result[0];
      if (lastSelected.index - valid[i].index >= minDistance) {
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
  if (!swingA || !swingB) return false;
  if (swingA.type !== swingB.type) return false;

  if (
    !Number.isInteger(swingA.index) ||
    !Number.isInteger(swingB.index) ||
    !Number.isFinite(swingA.price) ||
    !Number.isFinite(swingB.price) ||
    !Number.isInteger(swingA.confirmed_index) ||
    !Number.isInteger(swingB.confirmed_index)
  ) {
    return false;
  }

  const minDistance = getConfigNumber("MIN_SWING_DISTANCE", 10, 1);

  if (swingB.index <= swingA.index) return false;
  if (swingB.index - swingA.index < minDistance) return false;
  if (swingB.confirmed_index <= swingA.confirmed_index) return false;

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
  if (!trendline || !Number.isFinite(index)) return null;
  const price = trendline.slope * index + trendline.intercept;
  return Number.isFinite(price) ? price : null;
}

export function detectBreakout(candles, trendline, lineDirection, startIndex) {
  if (!Array.isArray(candles) || !trendline || !Number.isInteger(startIndex)) {
    return null;
  }

  const firstIndex = Math.max(1, startIndex);

  for (let i = firstIndex; i < candles.length; i++) {
    const previous = candles[i - 1];
    const candle = candles[i];

    if (!isValidCandle(previous) || !isValidCandle(candle)) continue;

    const previousLine = getTrendlinePrice(trendline, i - 1);
    const currentLine = getTrendlinePrice(trendline, i);

    if (!Number.isFinite(previousLine) || !Number.isFinite(currentLine)) continue;

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
  if (
    !Array.isArray(candles) ||
    !Number.isInteger(startIndex) ||
    startIndex < 0 ||
    !Number.isInteger(maxBars) ||
    maxBars < 1 ||
    !Number.isFinite(zoneLow) ||
    !Number.isFinite(zoneHigh) ||
    zoneLow > zoneHigh
  ) {
    return null;
  }

  const endIndex = Math.min(candles.length - 1, startIndex + maxBars);

  for (let i = startIndex + 1; i <= endIndex; i++) {
    const candle = candles[i];
    if (!isValidCandle(candle)) continue;

    const touchedZone = cLow(candle) <= zoneHigh && cHigh(candle) >= zoneLow;
    if (!touchedZone) continue;

    return {
      index: i,
      candle,
      entryPrice: (zoneHigh + zoneLow) / 2
    };
  }

  return null;
}

export function calculateEMA(candles, period = 50) {
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
