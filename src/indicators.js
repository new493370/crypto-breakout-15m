import { CONFIG } from "./config.js";

export function cHigh(c) { return c?.high; }
export function cLow(c) { return c?.low; }
export function cOpen(c) { return c?.open; }
export function cClose(c) { return c?.close; }

export function cVol(c) {
  return Number.isFinite(c?.volume) && c.volume >= 0
    ? c.volume
    : 0;
}

export function cRange(c) {
  return isValidCandle(c) ? c.high - c.low : 0;
}

export function cBody(c) {
  return isValidCandle(c)
    ? Math.abs(c.close - c.open)
    : 0;
}

export function isBull(c) {
  return isValidCandle(c) && c.close > c.open;
}

export function isBear(c) {
  return isValidCandle(c) && c.close < c.open;
}

function isValidCandle(c) {
  return Boolean(
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
  if (
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    a <= 0 ||
    b <= 0
  ) {
    return 0;
  }

  const midpoint = (a + b) / 2;

  return midpoint > 0
    ? Math.abs(a - b) / midpoint * 100
    : 0;
}

function getTrueRange(current, previous) {
  if (
    !isValidCandle(current) ||
    !isValidCandle(previous) ||
    current.time <= previous.time
  ) {
    return null;
  }

  const trueRange = Math.max(
    current.high - current.low,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close)
  );

  return Number.isFinite(trueRange) && trueRange >= 0
    ? trueRange
    : null;
}

function getSafeOption(options, key, fallback, min = 0) {
  const value = options?.[key];

  return Number.isFinite(value) && value >= min
    ? value
    : fallback;
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

  let atr = null;
  let seedSum = 0;
  let seedCount = 0;

  for (let i = 1; i < candles.length; i++) {
    const trueRange = getTrueRange(
      candles[i],
      candles[i - 1]
    );

    if (trueRange === null) {
      atr = null;
      seedSum = 0;
      seedCount = 0;
      continue;
    }

    if (atr === null) {
      seedSum += trueRange;
      seedCount++;

      if (seedCount === period) {
        atr = seedSum / period;
      }

      continue;
    }

    atr = (
      atr * (period - 1) + trueRange
    ) / period;
  }

  return Number.isFinite(atr) && atr > 0
    ? atr
    : null;
}

export function detectSwings(
  candles,
  left = CONFIG.SWING_LEFT,
  right = CONFIG.SWING_RIGHT
) {
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

  const rawSwings = [];

  for (let i = left; i < candles.length - right; i++) {
    const current = candles[i];

    if (!isValidCandle(current)) continue;

    let validWindow = true;
    let isHigh = true;
    let isLow = true;

    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;

      const candle = candles[j];

      if (
        !isValidCandle(candle) ||
        candle.time <= candles[j - 1]?.time
      ) {
        validWindow = false;
        break;
      }

      if (candle.high >= current.high) {
        isHigh = false;
      }

      if (candle.low <= current.low) {
        isLow = false;
      }

      if (!isHigh && !isLow) break;
    }

    if (!validWindow || isHigh === isLow) continue;

    const type = isHigh ? "high" : "low";

    rawSwings.push({
      index: i,
      price: type === "high" ? current.high : current.low,
      confirmed_index: i + right,
      confirmed_time: candles[i + right].time,
      type
    });
  }

  const minDistance = Math.max(
    1,
    Number.isInteger(CONFIG.MIN_CANDLES_BETWEEN_PIVOTS)
      ? CONFIG.MIN_CANDLES_BETWEEN_PIVOTS
      : 3
  );

  const minDifference = Math.max(
    0,
    Number.isFinite(CONFIG.MIN_LEVEL_DIFF_PERCENT)
      ? CONFIG.MIN_LEVEL_DIFF_PERCENT
      : 0.1
  );

  const filtered = [];

  for (const current of rawSwings) {
    if (filtered.length === 0) {
      filtered.push(current);
      continue;
    }

    const last = filtered[filtered.length - 1];

    if (current.type === last.type) {
      const moreExtreme = current.type === "high"
        ? current.price > last.price
        : current.price < last.price;

      if (moreExtreme) {
        filtered[filtered.length - 1] = current;
      }

      continue;
    }

    const distance = current.index - last.index;

    const priceDifference = getPercentDifference(
      last.price,
      current.price
    );

    if (
      distance < minDistance ||
      priceDifference < minDifference
    ) {
      continue;
    }

    filtered.push(current);
  }

  return {
    highs: filtered.filter(s => s.type === "high"),
    lows: filtered.filter(s => s.type === "low")
  };
}

export function getLatestMinorSwings(swings, count = 2) {
  const safeCount = Number.isInteger(count) && count > 0
    ? count
    : 2;

  return {
    highs: Array.isArray(swings?.highs)
      ? swings.highs.slice(-safeCount)
      : [],
    lows: Array.isArray(swings?.lows)
      ? swings.lows.slice(-safeCount)
      : []
  };
}

export function getConfirmedSwings(swings, currentIndex) {
  if (
    !swings ||
    !Number.isInteger(currentIndex) ||
    currentIndex < 0
  ) {
    return { highs: [], lows: [] };
  }

  const filterConfirmed = (list, type) => {
    if (!Array.isArray(list)) return [];

    return list.filter(swing =>
      swing &&
      swing.type === type &&
      Number.isInteger(swing.index) &&
      Number.isInteger(swing.confirmed_index) &&
      Number.isFinite(swing.price) &&
      swing.price > 0 &&
      swing.index >= 0 &&
      swing.confirmed_index >= swing.index &&
      swing.confirmed_index <= currentIndex
    );
  };

  return {
    highs: filterConfirmed(swings.highs, "high"),
    lows: filterConfirmed(swings.lows, "low")
  };
}

export function isValidStructure(swingA, swingB, direction) {
  if (
    !swingA ||
    !swingB ||
    !Number.isFinite(swingA.price) ||
    !Number.isFinite(swingB.price) ||
    swingA.price <= 0 ||
    swingB.price <= 0 ||
    !Number.isInteger(swingA.index) ||
    !Number.isInteger(swingB.index) ||
    swingA.index < 0 ||
    swingB.index <= swingA.index ||
    swingA.type !== swingB.type
  ) {
    return false;
  }

  const minDistance = Math.max(
    1,
    Number.isInteger(CONFIG.MIN_SWING_DISTANCE)
      ? CONFIG.MIN_SWING_DISTANCE
      : 8
  );

  if (swingB.index - swingA.index < minDistance) {
    return false;
  }

  const minDifference = Math.max(
    0,
    Number.isFinite(CONFIG.MIN_LEVEL_DIFF_PERCENT)
      ? CONFIG.MIN_LEVEL_DIFF_PERCENT
      : 0.1
  );

  if (
    getPercentDifference(swingA.price, swingB.price) <
    minDifference
  ) {
    return false;
  }

  if (
    direction === "bearish" &&
    swingA.type === "high"
  ) {
    return swingB.price < swingA.price;
  }

  if (
    direction === "bullish" &&
    swingA.type === "low"
  ) {
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
    swingA.price <= 0 ||
    swingB.price <= 0 ||
    !Number.isInteger(swingA.index) ||
    !Number.isInteger(swingB.index) ||
    swingA.index < 0 ||
    swingB.index <= swingA.index
  ) {
    return null;
  }

  const slope = (
    swingB.price - swingA.price
  ) / (
    swingB.index - swingA.index
  );

  const intercept = (
    swingA.price - slope * swingA.index
  );

  if (
    !Number.isFinite(slope) ||
    !Number.isFinite(intercept)
  ) {
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

  const price = (
    trendline.slope * index + trendline.intercept
  );

  return Number.isFinite(price) && price > 0
    ? price
    : null;
}

export function detectBreakout(
  candles,
  trendline,
  lineDirection,
  startIndex,
  options = {}
) {
  if (
    !Array.isArray(candles) ||
    candles.length < 16 ||
    !trendline ||
    !Number.isInteger(startIndex) ||
    startIndex < 1 ||
    startIndex >= candles.length ||
    !["bullish", "bearish"].includes(lineDirection)
  ) {
    return null;
  }

  const atrPeriod = options.atrPeriod ?? 14;
  const minBodyRatio = options.minBodyRatio ?? 0.5;
  const minClosePosition = options.minClosePosition ?? 0.7;
  const breakoutBufferAtr = options.breakoutBufferAtr ?? 0.05;
  const minBodyAtr = options.minBodyAtr ?? 0;

  if (
    !Number.isInteger(atrPeriod) ||
    atrPeriod < 1 ||
    !Number.isFinite(minBodyRatio) ||
    minBodyRatio < 0 ||
    minBodyRatio > 1 ||
    !Number.isFinite(minClosePosition) ||
    minClosePosition < 0.5 ||
    minClosePosition > 1 ||
    !Number.isFinite(breakoutBufferAtr) ||
    breakoutBufferAtr < 0 ||
    !Number.isFinite(minBodyAtr) ||
    minBodyAtr < 0
  ) {
    return null;
  }

  let latestBreakout = null;

  for (let i = startIndex; i < candles.length; i++) {
    const previous = candles[i - 1];
    const candle = candles[i];

    if (
      !isValidCandle(previous) ||
      !isValidCandle(candle) ||
      candle.time <= previous.time
    ) {
      continue;
    }

    const previousLine = getTrendlinePrice(
      trendline,
      i - 1
    );

    const currentLine = getTrendlinePrice(
      trendline,
      i
    );

    if (
      previousLine === null ||
      currentLine === null
    ) {
      continue;
    }

    const atr = calculateATR(
      candles.slice(0, i + 1),
      atrPeriod
    );

    if (!Number.isFinite(atr) || atr <= 0) continue;

    const range = cRange(candle);

    if (range <= 0) continue;

    const body = cBody(candle);
    const bodyRatio = body / range;
    const closePosition = (
      cClose(candle) - cLow(candle)
    ) / range;

    const buffer = atr * breakoutBufferAtr;

    let tradeDirection = null;

    if (
      lineDirection === "bearish" &&
      cClose(previous) <= previousLine &&
      cClose(candle) > currentLine + buffer &&
      isBull(candle) &&
      bodyRatio >= minBodyRatio &&
      body >= atr * minBodyAtr &&
      closePosition >= minClosePosition
    ) {
      tradeDirection = "bullish";
    } else if (
      lineDirection === "bullish" &&
      cClose(previous) >= previousLine &&
      cClose(candle) < currentLine - buffer &&
      isBear(candle) &&
      bodyRatio >= minBodyRatio &&
      body >= atr * minBodyAtr &&
      closePosition <= 1 - minClosePosition
    ) {
      tradeDirection = "bearish";
    }

    if (!tradeDirection) continue;

    const zoneHigh = candle.high;
    const zoneLow = candle.low;
    const zoneWidth = zoneHigh - zoneLow;

    if (zoneWidth <= 0) continue;

    latestBreakout = {
      index: i,
      direction: tradeDirection,
      lineDirection,
      candle,
      zoneLow,
      zoneHigh,
      zoneWidth,
      linePrice: currentLine,
      atr,
      strength: clamp(
        bodyRatio * 50 +
        Math.min(body / atr, 2) * 25,
        0,
        100
      ),
      confirmed: true,
      candleTime: candle.time
    };
  }

  return latestBreakout;
}

function getCandleRejection(candle, direction) {
  if (!isValidCandle(candle)) return false;

  const range = cRange(candle);

  if (range <= 0) return false;

  const upperWick = (
    candle.high - Math.max(candle.open, candle.close)
  );

  const lowerWick = (
    Math.min(candle.open, candle.close) - candle.low
  );

  const bodyRatio = cBody(candle) / range;
  const closePosition = (
    candle.close - candle.low
  ) / range;

  if (direction === "bullish") {
    return (
      isBull(candle) &&
      bodyRatio >= 0.2 &&
      closePosition >= 0.6 &&
      lowerWick / range >= 0.2
    );
  }

  if (direction === "bearish") {
    return (
      isBear(candle) &&
      bodyRatio >= 0.2 &&
      closePosition <= 0.4 &&
      upperWick / range >= 0.2
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
  zoneHigh,
  options = {}
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
    zoneLow <= 0 ||
    zoneLow >= zoneHigh ||
    startIndex >= candles.length - 1
  ) {
    return null;
  }

  const minMoveAwayZone = getSafeOption(
    options,
    "minMoveAwayZone",
    0.5
  );

  const minMoveAwayAtr = getSafeOption(
    options,
    "minMoveAwayAtr",
    0.25
  );

  const atrPeriod = options.atrPeriod ?? 14;

  if (
    !Number.isInteger(atrPeriod) ||
    atrPeriod < 1
  ) {
    return null;
  }

  const atr = calculateATR(
    candles.slice(0, startIndex + 1),
    atrPeriod
  );

  const minimumMove = Math.max(
    (zoneHigh - zoneLow) * minMoveAwayZone,
    Number.isFinite(atr)
      ? atr * minMoveAwayAtr
      : 0
  );

  const endIndex = Math.min(
    candles.length - 1,
    startIndex + maxBars
  );

  let movedAway = false;

  for (
    let i = startIndex + 1;
    i <= endIndex;
    i++
  ) {
    const candle = candles[i];

    if (!isValidCandle(candle)) continue;

    if (!movedAway) {
      movedAway = direction === "bullish"
        ? candle.close >= zoneHigh + minimumMove
        : candle.close <= zoneLow - minimumMove;

      continue;
    }

    const invalidated = direction === "bullish"
      ? candle.close < zoneLow
      : candle.close > zoneHigh;

    if (invalidated) return null;

    const touchedZone = (
      candle.low <= zoneHigh &&
      candle.high >= zoneLow
    );

    if (!touchedZone) continue;

    if (!getCandleRejection(candle, direction)) {
      continue;
    }

    return {
      index: i,
      candle,
      entryPrice: (zoneHigh + zoneLow) / 2,
      zoneLow,
      zoneHigh,
      direction,
      confirmed: true,
      rejection: true,
      movedAway: true
    };
  }

  return null;
}

function detectDisplacement(
  candle,
  atr,
  direction,
  options = {}
) {
  if (
    !isValidCandle(candle) ||
    !Number.isFinite(atr) ||
    atr <= 0
  ) {
    return false;
  }

  const range = cRange(candle);
  const body = cBody(candle);

  if (range <= 0) return false;

  const minBodyAtr = options.minBodyAtr ?? 1.2;
  const minBodyRatio = options.minBodyRatio ?? 0.55;
  const minClosePosition = options.minClosePosition ?? 0.7;

  if (
    !Number.isFinite(minBodyAtr) ||
    minBodyAtr <= 0 ||
    !Number.isFinite(minBodyRatio) ||
    minBodyRatio < 0 ||
    minBodyRatio > 1 ||
    !Number.isFinite(minClosePosition) ||
    minClosePosition < 0.5 ||
    minClosePosition > 1
  ) {
    return false;
  }

  const bodyRatio = body / range;
  const closePosition = (
    candle.close - candle.low
  ) / range;

  if (
    body < atr * minBodyAtr ||
    bodyRatio < minBodyRatio
  ) {
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

function detectBase(
  candles,
  endIndex,
  atr,
  options = {}
) {
  if (
    !Array.isArray(candles) ||
    !Number.isInteger(endIndex) ||
    endIndex < 0 ||
    endIndex >= candles.length ||
    !Number.isFinite(atr) ||
    atr <= 0
  ) {
    return null;
  }

  const maxBaseCandles = options.maxBaseCandles ?? 4;
  const minBaseCandles = options.minBaseCandles ?? 1;
  const maxRangeAtr = options.maxBaseRangeAtr ?? 1.2;
  const maxBodyAtr = options.maxBaseBodyAtr ?? 0.65;

  if (
    !Number.isInteger(maxBaseCandles) ||
    !Number.isInteger(minBaseCandles) ||
    minBaseCandles < 1 ||
    maxBaseCandles < minBaseCandles ||
    !Number.isFinite(maxRangeAtr) ||
    maxRangeAtr <= 0 ||
    !Number.isFinite(maxBodyAtr) ||
    maxBodyAtr < 0
  ) {
    return null;
  }

  const base = [];

  for (
    let i = endIndex;
    i >= Math.max(0, endIndex - maxBaseCandles + 1);
    i--
  ) {
    const candle = candles[i];

    if (!isValidCandle(candle)) break;

    if (
      i < endIndex &&
      candle.time >= candles[i + 1].time
    ) {
      break;
    }

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

  const low = Math.min(
    ...candlesInBase.map(c => c.low)
  );

  const high = Math.max(
    ...candlesInBase.map(c => c.high)
  );

  if (
    !Number.isFinite(low) ||
    !Number.isFinite(high) ||
    low <= 0 ||
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

export function detectSupplyDemandZones(
  candles,
  direction,
  options = {}
) {
  if (
    !Array.isArray(candles) ||
    candles.length < 20 ||
    !["bullish", "bearish"].includes(direction)
  ) {
    return [];
  }

  const atrPeriod = options.atrPeriod ?? 14;
  const maxAge = options.maxAge ?? 100;
  const maxResults = options.maxResults ?? 10;
  const maxZoneAtr = options.maxZoneAtr ?? 2.5;

  if (
    !Number.isInteger(atrPeriod) ||
    atrPeriod < 1 ||
    !Number.isInteger(maxAge) ||
    maxAge < 1 ||
    !Number.isInteger(maxResults) ||
    maxResults < 1 ||
    !Number.isFinite(maxZoneAtr) ||
    maxZoneAtr <= 0
  ) {
    return [];
  }

  const lastCandle = candles[candles.length - 1];

  if (!isValidCandle(lastCandle)) return [];

  const currentPrice = lastCandle.close;
  const zones = [];
  const startIndex = Math.max(
    1,
    candles.length - maxAge
  );

  for (let i = startIndex; i < candles.length; i++) {
    const displacement = candles[i];

    if (!isValidCandle(displacement)) continue;

    const atr = calculateATR(
      candles.slice(0, i + 1),
      atrPeriod
    );

    if (!Number.isFinite(atr) || atr <= 0) {
      continue;
    }

    if (
      !detectDisplacement(
        displacement,
        atr,
        direction,
        options
      )
    ) {
      continue;
    }

    const base = detectBase(
      candles,
      i - 1,
      atr,
      options
    );

    if (
      !base ||
      base.endIndex !== i - 1
    ) {
      continue;
    }

    const bullishBaseHigh = Math.max(
      ...base.candles.map(c =>
        Math.max(c.open, c.close)
      )
    );

    const bearishBaseLow = Math.min(
      ...base.candles.map(c =>
        Math.min(c.open, c.close)
      )
    );

    const zoneLow = direction === "bullish"
      ? base.low
      : bearishBaseLow;

    const zoneHigh = direction === "bullish"
      ? bullishBaseHigh
      : base.high;

    const zoneWidth = zoneHigh - zoneLow;

    if (
      !Number.isFinite(zoneWidth) ||
      zoneWidth <= 0 ||
      zoneWidth > atr * maxZoneAtr
    ) {
      continue;
    }

    const displacementIsValid = direction === "bullish"
      ? displacement.close > base.high
      : displacement.close < base.low;

    if (!displacementIsValid) continue;

    const isCorrectSide = direction === "bullish"
      ? currentPrice > zoneHigh
      : currentPrice < zoneLow;

    if (!isCorrectSide) continue;

    let isBroken = false;

    for (let j = i + 1; j < candles.length; j++) {
      const laterCandle = candles[j];

      if (!isValidCandle(laterCandle)) continue;

      const broken = direction === "bullish"
        ? laterCandle.close < zoneLow
        : laterCandle.close > zoneHigh;

      if (broken) {
        isBroken = true;
        break;
      }
    }

    if (isBroken) continue;

    const displacementStrength = (
      cBody(displacement) / atr
    );

    const baseCompactness = 1 - clamp(
      base.width / (atr * 2.5),
      0,
      1
    );

    const strength = clamp(
      displacementStrength * 25 +
      baseCompactness * 35 +
      Math.min(base.candleCount, 4) * 5,
      0,
      100
    );

    const distance = direction === "bullish"
      ? currentPrice - zoneHigh
      : zoneLow - currentPrice;

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
    const overlaps = uniqueZones.some(existing =>
      zone.low <= existing.high &&
      zone.high >= existing.low
    );

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
    zone.low <= 0 ||
    zone.low >= zone.high ||
    !Number.isInteger(startIndex) ||
    startIndex < 0 ||
    startIndex >= candles.length - 1
  ) {
    return null;
  }

  const direction = zone.direction;

  if (!["bullish", "bearish"].includes(direction)) {
    return null;
  }

  const maxBars = options.maxBars ?? candles.length;
  const tolerance = options.tolerancePercent ?? 0;

  if (
    !Number.isInteger(maxBars) ||
    maxBars < 1 ||
    !Number.isFinite(tolerance) ||
    tolerance < 0
  ) {
    return null;
  }

  const endIndex = Math.min(
    candles.length - 1,
    startIndex + maxBars
  );

  const midpoint = (zone.low + zone.high) / 2;

  const toleranceValue = (
    zone.high - zone.low
  ) * tolerance / 100;

  for (
    let i = startIndex + 1;
    i <= endIndex;
    i++
  ) {
    const candle = candles[i];

    if (!isValidCandle(candle)) continue;

    const invalidated = direction === "bullish"
      ? candle.close < zone.low
      : candle.close > zone.high;

    if (invalidated) {
      return {
        index: i,
        candle,
        invalidated: true,
        confirmed: false,
        direction
      };
    }

    const touched = (
      candle.low <= zone.high + toleranceValue &&
      candle.high >= zone.low - toleranceValue
    );

    if (!touched) continue;

    if (!getCandleRejection(candle, direction)) {
      continue;
    }

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
    !Number.isFinite(zone.low) ||
    !Number.isFinite(zone.high) ||
    zone.low <= 0 ||
    zone.low >= zone.high ||
    !Number.isInteger(retestIndex) ||
    retestIndex < 0 ||
    retestIndex >= candles.length - 1
  ) {
    return null;
  }

  const direction = zone.direction;

  if (!["bullish", "bearish"].includes(direction)) {
    return null;
  }

  const confirmationBars = options.confirmationBars ?? 3;

  if (
    !Number.isInteger(confirmationBars) ||
    confirmationBars < 1
  ) {
    return null;
  }

  const midpoint = (zone.low + zone.high) / 2;

  const endIndex = Math.min(
    candles.length - 1,
    retestIndex + confirmationBars
  );

  for (
    let i = retestIndex + 1;
    i <= endIndex;
    i++
  ) {
    const candle = candles[i];

    if (!isValidCandle(candle)) continue;

    const invalidated = direction === "bullish"
      ? candle.close < zone.low
      : candle.close > zone.high;

    if (invalidated) return null;

    const confirmed = direction === "bullish"
      ? isBull(candle) && candle.close > midpoint
      : isBear(candle) && candle.close < midpoint;

    if (!confirmed) continue;

    return {
      index: i,
      candle,
      direction,
      confirmationPrice: candle.close,
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

  const closes = [];

  for (const candle of candles) {
    if (!isValidCandle(candle)) return null;

    closes.push(candle.close);
  }

  const multiplier = 2 / (period + 1);

  let ema = closes
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < closes.length; i++) {
    ema = (
      (closes[i] - ema) * multiplier + ema
    );
  }

  return Number.isFinite(ema) && ema > 0
    ? ema
    : null;
}
