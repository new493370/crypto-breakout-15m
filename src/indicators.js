
import { CONFIG } from "./config.js";

export function cHigh(c) { return c.high; }
export function cLow(c) { return c.low; }
export function cOpen(c) { return c.open; }
export function cClose(c) { return c.close; }
export function cVol(c) { return Number.isFinite(c?.volume) ? c.volume : 0; }
export function cRange(c) { return Math.max(cHigh(c) - cLow(c), 0); }
export function cBody(c) { return Math.abs(cClose(c) - cOpen(c)); }
export function isBull(c) { return cClose(c) > cOpen(c); }
export function isBear(c) { return cClose(c) < cOpen(c); }

function isValidCandle(c) {
  return (
    c &&
    c.incomplete !== true &&
    Number.isFinite(c.time) &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close) &&
    c.open > 0 &&
    c.high >= Math.max(c.open, c.close) &&
    c.low <= Math.min(c.open, c.close) &&
    c.high >= c.low &&
    c.low > 0
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getPercentDifference(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) {
    return 0;
  }

  return Math.abs((b - a) / a) * 100;
}

export function calculateATR(candles, period = 14) {
  if (
    !Array.isArray(candles) ||
    !Number.isInteger(period) ||
    period < 1 ||
    candles.length < period + 1
  ) {
    return null;
  }

  const trueRanges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    if (!isValidCandle(current) || !isValidCandle(previous)) {
      continue;
    }

    const trueRange = Math.max(
      cHigh(current) - cLow(current),
      Math.abs(cHigh(current) - cClose(previous)),
      Math.abs(cLow(current) - cClose(previous))
    );

    if (Number.isFinite(trueRange)) {
      trueRanges.push(trueRange);
    }
  }

  if (trueRanges.length < period) return null;

  let atr = trueRanges
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < trueRanges.length; i++) {
    atr = ((atr * (period - 1)) + trueRanges[i]) / period;
  }

  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

export function detectSwings(
  candles,
  left = CONFIG.SWING_LEFT,
  right = CONFIG.SWING_RIGHT
) {
  const rawHighs = [];
  const rawLows = [];

  if (
    !Array.isArray(candles) ||
    !Number.isInteger(left) ||
    !Number.isInteger(right) ||
    left < 1 ||
    right < 1 ||
    candles.length < left + right + 1
  ) {
    return { highs: [], lows: [] };
  }

  for (let i = left; i < candles.length - right; i++) {
    const current = candles[i];

    if (!isValidCandle(current)) continue;

    const high = cHigh(current);
    const low = cLow(current);

    let isHigh = true;
    let isLow = true;

    for (let j = i - left; j < i; j++) {
      const candle = candles[j];

      if (!isValidCandle(candle)) {
        isHigh = false;
        isLow = false;
        break;
      }

      if (cHigh(candle) >= high) isHigh = false;
      if (cLow(candle) <= low) isLow = false;
    }

    if (!isHigh && !isLow) continue;

    for (let j = i + 1; j <= i + right; j++) {
      const candle = candles[j];

      if (!isValidCandle(candle)) {
        isHigh = false;
        isLow = false;
        break;
      }

      if (cHigh(candle) >= high) isHigh = false;
      if (cLow(candle) <= low) isLow = false;
    }

    if (isHigh) {
      rawHighs.push({
        index: i,
        price: high,
        confirmed_index: i + right,
        confirmed_time: candles[i + right].time,
        type: "high"
      });
    }

    if (isLow) {
      rawLows.push({
        index: i,
        price: low,
        confirmed_index: i + right,
        confirmed_time: candles[i + right].time,
        type: "low"
      });
    }
  }

  const merged = [...rawHighs, ...rawLows].sort(
    (a, b) => a.index - b.index || a.type.localeCompare(b.type)
  );

  const filtered = [];

  for (const current of merged) {
    if (filtered.length === 0) {
      filtered.push(current);
      continue;
    }

    const last = filtered[filtered.length - 1];

    if (last.type === current.type) {
      const isMoreExtreme =
        current.type === "high"
          ? current.price > last.price
          : current.price < last.price;

      if (isMoreExtreme) {
        filtered[filtered.length - 1] = current;
      }

      continue;
    }

    const priceDiffPercent = getPercentDifference(
      last.price,
      current.price
    );

    const minDistance = CONFIG.MIN_CANDLES_BETWEEN_PIVOTS ?? 3;
    const minDifference = CONFIG.MIN_LEVEL_DIFF_PERCENT ?? 0.1;

    const isTimeValid =
      current.index - last.index >= minDistance;

    const isPriceValid =
      priceDiffPercent >= minDifference;

    if (isTimeValid && isPriceValid) {
      filtered.push(current);
    } else if (
      last.type === "high" &&
      current.type === "low" &&
      current.price < last.price
    ) {
      filtered[filtered.length - 1] = current;
    } else if (
      last.type === "low" &&
      current.type === "high" &&
      current.price > last.price
    ) {
      filtered[filtered.length - 1] = current;
    }
  }

  return {
    highs: filtered.filter(s => s.type === "high"),
    lows: filtered.filter(s => s.type === "low")
  };
}

export function getLatestMinorSwings(swings, count = 2) {
  const safeCount = Number.isInteger(count) && count > 0 ? count : 2;

  return {
    highs: (swings?.highs || []).slice(-safeCount),
    lows: (swings?.lows || []).slice(-safeCount)
  };
}

export function getConfirmedSwings(swings, currentIndex) {
  if (!swings || !Number.isInteger(currentIndex)) {
    return { highs: [], lows: [] };
  }

  return {
    highs: (swings.highs || []).filter(
      swing => swing.confirmed_index <= currentIndex
    ),
    lows: (swings.lows || []).filter(
      swing => swing.confirmed_index <= currentIndex
    )
  };
}

export function isValidStructure(swingA, swingB, direction) {
  if (!swingA || !swingB) return false;
  if (swingA.type !== swingB.type) return false;
  if (swingB.index <= swingA.index) return false;

  if (
    swingB.index - swingA.index <
    (CONFIG.MIN_SWING_DISTANCE ?? 8)
  ) {
    return false;
  }

  const priceDiffPercent = getPercentDifference(
    swingA.price,
    swingB.price
  );

  if (
    priceDiffPercent <
    (CONFIG.MIN_LEVEL_DIFF_PERCENT ?? 0.1)
  ) {
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
  if (
    !swingA ||
    !swingB ||
    !Number.isFinite(swingA.price) ||
    !Number.isFinite(swingB.price) ||
    !Number.isInteger(swingA.index) ||
    !Number.isInteger(swingB.index) ||
    swingB.index <= swingA.index
  ) {
    return null;
  }

  const slope =
    (swingB.price - swingA.price) /
    (swingB.index - swingA.index);

  const intercept = swingA.price - slope * swingA.index;

  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) {
    return null;
  }

  return { slope, intercept };
}

export function getTrendlinePrice(trendline, index) {
  if (
    !trendline ||
    !Number.isFinite(trendline.slope) ||
    !Number.isFinite(trendline.intercept) ||
    !Number.isFinite(index)
  ) {
    return null;
  }

  const price = trendline.slope * index + trendline.intercept;

  return Number.isFinite(price) ? price : null;
}

export function detectBreakout(
  candles,
  trendline,
  lineDirection,
  startIndex
) {
  if (
    !Array.isArray(candles) ||
    candles.length < 2 ||
    !trendline ||
    !Number.isInteger(startIndex) ||
    !["bullish", "bearish"].includes(lineDirection)
  ) {
    return null;
  }

  const firstIndex = Math.max(1, startIndex);
  let latestBreakout = null;

  for (let i = firstIndex; i < candles.length; i++) {
    const previous = candles[i - 1];
    const candle = candles[i];

    if (!isValidCandle(previous) || !isValidCandle(candle)) {
      continue;
    }

    const previousLine = getTrendlinePrice(trendline, i - 1);
    const currentLine = getTrendlinePrice(trendline, i);

    if (
      !Number.isFinite(previousLine) ||
      !Number.isFinite(currentLine)
    ) {
      continue;
    }

    let tradeDirection = null;

    if (
      lineDirection === "bearish" &&
      cClose(previous) <= previousLine &&
      cClose(candle) > currentLine
    ) {
      tradeDirection = "bullish";
    }

    if (
      lineDirection === "bullish" &&
      cClose(previous) >= previousLine &&
      cClose(candle) < currentLine
    ) {
      tradeDirection = "bearish";
    }

    if (!tradeDirection) continue;

    const zoneHigh = cHigh(candle);
    const zoneLow = cLow(candle);
    const zoneWidth = zoneHigh - zoneLow;

    if (!Number.isFinite(zoneWidth) || zoneWidth <= 0) {
      continue;
    }

    latestBreakout = {
      index: i,
      direction: tradeDirection,
      lineDirection,
      candle,
      zoneLow,
      zoneHigh,
      zoneWidth,
      linePrice: currentLine,
      confirmed: true,
      candleTime: candle.time
    };
  }

  return latestBreakout;
}

function getCandleRejection(candle, direction) {
  const range = cRange(candle);

  if (range <= 0) return false;

  const upperWick = cHigh(candle) - Math.max(
    cOpen(candle),
    cClose(candle)
  );

  const lowerWick = Math.min(
    cOpen(candle),
    cClose(candle)
  ) - cLow(candle);

  const body = cBody(candle);
  const closePosition = (cClose(candle) - cLow(candle)) / range;

  if (direction === "bullish") {
    return (
      isBull(candle) &&
      (
        closePosition >= 0.6 ||
        lowerWick / range >= 0.35
      ) &&
      body / range >= 0.15
    );
  }

  if (direction === "bearish") {
    return (
      isBear(candle) &&
      (
        closePosition <= 0.4 ||
        upperWick / range >= 0.35
      ) &&
      body / range >= 0.15
    );
  }

  return false;
}

export function detectFirstPullback(
  candles,
  direction,
  startIndex,
  maxBars,
  zoneLow,
  zoneHigh
) {
  if (
    !Array.isArray(candles) ||
    !["bullish", "bearish"].includes(direction) ||
    !Number.isInteger(startIndex) ||
    !Number.isInteger(maxBars) ||
    startIndex < 0 ||
    maxBars < 1 ||
    !Number.isFinite(zoneLow) ||
    !Number.isFinite(zoneHigh) ||
    zoneLow >= zoneHigh
  ) {
    return null;
  }

  const endIndex = Math.min(
    candles.length - 1,
    startIndex + maxBars
  );

  for (let i = startIndex + 1; i <= endIndex; i++) {
    const candle = candles[i];

    if (!isValidCandle(candle)) continue;

    const touchedZone =
      cLow(candle) <= zoneHigh &&
      cHigh(candle) >= zoneLow;

    if (!touchedZone) continue;

    const rejected = getCandleRejection(candle, direction);

    if (!rejected) continue;

    return {
      index: i,
      candle,
      entryPrice: (zoneHigh + zoneLow) / 2,
      zoneLow,
      zoneHigh,
      direction,
      confirmed: true,
      rejection: true
    };
  }

  return null;
}

function detectDisplacement(candle, atr, direction, options = {}) {
  if (!isValidCandle(candle) || !Number.isFinite(atr) || atr <= 0) {
    return false;
  }

  const range = cRange(candle);
  const body = cBody(candle);

  if (range <= 0) return false;

  const minBodyAtr = options.minBodyAtr ?? 1.2;
  const minBodyRatio = options.minBodyRatio ?? 0.55;
  const minClosePosition = options.minClosePosition ?? 0.7;

  const bodyRatio = body / range;

  const closePosition = (cClose(candle) - cLow(candle)) / range;

  if (body < atr * minBodyAtr || bodyRatio < minBodyRatio) {
    return false;
  }

  if (direction === "bullish") {
    return (
      isBull(candle) &&
      closePosition >= minClosePosition
    );
  }

  if (direction === "bearish") {
    return (
      isBear(candle) &&
      closePosition <= 1 - minClosePosition
    );
  }

  return false;
}

function detectBase(candles, endIndex, atr, options = {}) {
  const maxBaseCandles = options.maxBaseCandles ?? 4;
  const minBaseCandles = options.minBaseCandles ?? 1;
  const maxRangeAtr = options.maxBaseRangeAtr ?? 1.2;
  const maxBodyAtr = options.maxBaseBodyAtr ?? 0.65;

  const base = [];

  for (
    let i = endIndex;
    i >= Math.max(0, endIndex - maxBaseCandles + 1);
    i--
  ) {
    const candle = candles[i];

    if (!isValidCandle(candle)) break;

    if (
      cRange(candle) > atr * maxRangeAtr ||
      cBody(candle) > atr * maxBodyAtr
    ) {
      break;
    }

    base.unshift({
      index: i,
      candle
    });
  }

  if (base.length < minBaseCandles) return null;

  const candlesInBase = base.map(item => item.candle);

  const low = Math.min(...candlesInBase.map(c => cLow(c)));
  const high = Math.max(...candlesInBase.map(c => cHigh(c)));

  if (
    !Number.isFinite(low) ||
    !Number.isFinite(high) ||
    high <= low
  ) {
    return null;
  }

  return {
    startIndex: base[0].index,
    endIndex: base[base.length - 1].index,
    low,
    high,
    width: high - low,
    candleCount: base.length,
    candles: candlesInBase
  };
}

export function detectSupplyDemandZones(candles, direction, options = {}) {
  if (
    !Array.isArray(candles) ||
    candles.length < 20 ||
    !["bullish", "bearish"].includes(direction)
  ) {
    return [];
  }

  const atrPeriod = options.atrPeriod ?? 14;
  const atr = calculateATR(candles, atrPeriod);

  if (!Number.isFinite(atr) || atr <= 0) return [];

  const maxAge = options.maxAge ?? 100;
  const maxResults = options.maxResults ?? 10;
  const zones = [];

  const startIndex = Math.max(
    1,
    candles.length - maxAge
  );

  for (let i = startIndex; i < candles.length; i++) {
    const displacement = candles[i];

    if (!detectDisplacement(displacement, atr, direction, options)) {
      continue;
    }

    const base = detectBase(
      candles,
      i - 1,
      atr,
      options
    );

    if (!base) continue;

    const zoneLow = direction === "bullish"
      ? base.low
      : Math.min(...base.candles.map(c =>
          Math.min(cOpen(c), cClose(c))
        ));

    const zoneHigh = direction === "bullish"
      ? Math.max(...base.candles.map(c =>
          Math.max(cOpen(c), cClose(c))
        ))
      : base.high;

    const zoneWidth = zoneHigh - zoneLow;

    if (
      !Number.isFinite(zoneWidth) ||
      zoneWidth <= 0 ||
      zoneWidth > atr * (options.maxZoneAtr ?? 2.5)
    ) {
      continue;
    }

    const currentPrice = cClose(candles[candles.length - 1]);

    const isCorrectSide = direction === "bullish"
      ? currentPrice >= zoneLow
      : currentPrice <= zoneHigh;

    if (!isCorrectSide) continue;

    const isBroken = direction === "bullish"
      ? candles.slice(i + 1).some(c =>
          isValidCandle(c) && cClose(c) < zoneLow
        )
      : candles.slice(i + 1).some(c =>
          isValidCandle(c) && cClose(c) > zoneHigh
        );

    if (isBroken) continue;

    const distance = direction === "bullish"
      ? currentPrice - zoneHigh
      : zoneLow - currentPrice;

    const displacementStrength =
      cBody(displacement) / atr;

    const baseCompactness =
      1 - clamp(base.width / (atr * 2.5), 0, 1);

    const strength = clamp(
      displacementStrength * 25 +
      baseCompactness * 35 +
      Math.min(base.candleCount, 4) * 5,
      0,
      100
    );

    zones.push({
      type: direction === "bullish" ? "demand" : "supply",
      direction,
      low: zoneLow,
      high: zoneHigh,
      width: zoneWidth,
      atr,
      strength,
      baseStartIndex: base.startIndex,
      baseEndIndex: base.endIndex,
      displacementIndex: i,
      displacementTime: displacement.time,
      candleCount: base.candleCount,
      distance: Math.max(0, distance),
      broken: false,
      confirmed: true
    });
  }

  zones.sort((a, b) => {
    if (b.displacementIndex !== a.displacementIndex) {
      return b.displacementIndex - a.displacementIndex;
    }

    return b.strength - a.strength;
  });

  const uniqueZones = [];

  for (const zone of zones) {
    const overlaps = uniqueZones.some(existing => {
      return (
        zone.low <= existing.high &&
        zone.high >= existing.low
      );
    });

    if (!overlaps) {
      uniqueZones.push(zone);
    }

    if (uniqueZones.length >= maxResults) break;
  }

  return uniqueZones;
}

export function detectZoneRetest(
  candles,
  zone,
  startIndex,
  options = {}
) {
  if (
    !Array.isArray(candles) ||
    !zone ||
    !Number.isFinite(zone.low) ||
    !Number.isFinite(zone.high) ||
    zone.low >= zone.high ||
    !Number.isInteger(startIndex) ||
    startIndex < 0
  ) {
    return null;
  }

  const direction = zone.direction;

  if (!["bullish", "bearish"].includes(direction)) {
    return null;
  }

  const maxBars = options.maxBars ?? candles.length;
  const endIndex = Math.min(
    candles.length - 1,
    startIndex + maxBars
  );

  const midpoint = (zone.low + zone.high) / 2;
  const tolerance = options.tolerancePercent ?? 0;

  const toleranceValue = zone.width * tolerance / 100;

  for (let i = startIndex + 1; i <= endIndex; i++) {
    const candle = candles[i];

    if (!isValidCandle(candle)) continue;

    const touched =
      cLow(candle) <= zone.high + toleranceValue &&
      cHigh(candle) >= zone.low - toleranceValue;

    if (!touched) continue;

    const invalidated = direction === "bullish"
      ? cClose(candle) < zone.low
      : cClose(candle) > zone.high;

    if (invalidated) {
      return {
        index: i,
        candle,
        invalidated: true,
        confirmed: false,
        direction
      };
    }

    const rejection = getCandleRejection(candle, direction);

    if (!rejection) continue;

    return {
      index: i,
      candle,
      zoneLow: zone.low,
      zoneHigh: zone.high,
      entryPrice: midpoint,
      direction,
      touched: true,
      rejection: true,
      confirmed: true,
      invalidated: false
    };
  }

  return null;
}

export function confirmZoneReaction(
  candles,
  zone,
  retestIndex,
  options = {}
) {
  if (
    !Array.isArray(candles) ||
    !zone ||
    !Number.isInteger(retestIndex) ||
    retestIndex < 0 ||
    retestIndex >= candles.length
  ) {
    return null;
  }

  const direction = zone.direction;

  if (!["bullish", "bearish"].includes(direction)) {
    return null;
  }

  const confirmationBars = options.confirmationBars ?? 3;
  const midpoint = (zone.low + zone.high) / 2;

  const endIndex = Math.min(
    candles.length - 1,
    retestIndex + confirmationBars
  );

  for (let i = retestIndex; i <= endIndex; i++) {
    const candle = candles[i];

    if (!isValidCandle(candle)) continue;

    const invalidated = direction === "bullish"
      ? cClose(candle) < zone.low
      : cClose(candle) > zone.high;

    if (invalidated) {
      return null;
    }

    const confirmed = direction === "bullish"
      ? isBull(candle) && cClose(candle) > midpoint
      : isBear(candle) && cClose(candle) < midpoint;

    if (!confirmed) continue;

    return {
      index: i,
      candle,
      direction,
      confirmationPrice: cClose(candle),
      zoneLow: zone.low,
      zoneHigh: zone.high,
      confirmed: true
    };
  }

  return null;
}

export function calculateEMA(candles, period = 50) {
  if (
    !Array.isArray(candles) ||
    !Number.isInteger(period) ||
    period < 1 ||
    candles.length < period
  ) {
    return null;
  }

  const closes = candles.map(c => {
    return Number.isFinite(c?.close) ? c.close : null;
  });

  if (closes.some(value => value === null || value <= 0)) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let ema = closes
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] - ema) * multiplier + ema;
  }

  return Number.isFinite(ema) ? ema : null;
}
