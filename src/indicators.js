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

function getSafeOption(options, key, configKey, min = 0) {
  const value = options?.[key] ?? CONFIG?.[configKey];

  return Number.isFinite(value) && value >= min
    ? value
    : null;
}

function getConfigNumber(key, min = 0) {
  const value = CONFIG?.[key];

  return Number.isFinite(value) && value >= min
    ? value
    : null;
}

function isValidTimeSequence(candles, startIndex, endIndex) {
  if (
    !Array.isArray(candles) ||
    !Number.isInteger(startIndex) ||
    !Number.isInteger(endIndex) ||
    startIndex < 0 ||
    endIndex >= candles.length ||
    startIndex > endIndex
  ) {
    return false;
  }

  for (let i = startIndex; i <= endIndex; i++) {
    if (!isValidCandle(candles[i])) {
      return false;
    }

    if (
      i > startIndex &&
      candles[i].time <= candles[i - 1].time
    ) {
      return false;
    }
  }

  return true;
}

export function calculateATR(
  candles,
  period = CONFIG.ATR_PERIOD
) {
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

function detectPivot(candles, index, left, right) {
  const startIndex = index - left;
  const endIndex = index + right;

  if (
    startIndex < 0 ||
    endIndex >= candles.length ||
    !isValidTimeSequence(candles, startIndex, endIndex)
  ) {
    return null;
  }

  const current = candles[index];

  let isHigh = true;
  let isLow = true;

  for (let i = startIndex; i <= endIndex; i++) {
    if (i === index) continue;

    const candle = candles[i];

    if (
      i < index
        ? candle.high >= current.high
        : candle.high > current.high
    ) {
      isHigh = false;
    }

    if (
      i < index
        ? candle.low <= current.low
        : candle.low < current.low
    ) {
      isLow = false;
    }

    if (!isHigh && !isLow) break;
  }

  if (isHigh === isLow) return null;

  return {
    type: isHigh ? "high" : "low",
    index,
    price: isHigh ? current.high : current.low,
    confirmed_index: endIndex,
    confirmed_time: candles[endIndex].time,
    confirmed: true
  };
}

function filterAlternatingSwings(
  swings,
  minDistance,
  minDifference
) {
  const filtered = [];

  for (const current of swings) {
    if (filtered.length === 0) {
      filtered.push(current);
      continue;
    }

    const last = filtered[filtered.length - 1];

    if (current.type === last.type) {
      const moreExtreme = current.type === "high"
        ? current.price > last.price
        : current.price < last.price;

      if (!moreExtreme) continue;

      const previous = filtered[filtered.length - 2];

      const replacementIsValid = !previous ||
        (
          current.index - previous.index >= minDistance &&
          getPercentDifference(
            previous.price,
            current.price
          ) >= minDifference
        );

      if (replacementIsValid) {
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

  return filtered;
}

function getLiquidityConfig() {
  const atrPeriod = getConfigNumber(
    "LIQUIDITY_ATR_PERIOD",
    1
  );

  const toleranceAtr = getConfigNumber(
    "LIQUIDITY_CLUSTER_TOLERANCE_ATR"
  );

  const minTouches = getConfigNumber(
    "LIQUIDITY_MIN_TOUCHES",
    2
  );

  const minTouchGap = getConfigNumber(
    "LIQUIDITY_MIN_TOUCH_GAP",
    1
  );

  const maxTouchGap = getConfigNumber(
    "LIQUIDITY_MAX_TOUCH_GAP",
    1
  );

  const minSweepAtr = getConfigNumber(
    "LIQUIDITY_SWEEP_MIN_ATR"
  );

  const maxSweepAtr = getConfigNumber(
    "LIQUIDITY_SWEEP_MAX_ATR"
  );

  const displacementLookahead = getConfigNumber(
    "LIQUIDITY_DISPLACEMENT_LOOKAHEAD",
    1
  );

  if (
    [
      atrPeriod,
      toleranceAtr,
      minTouches,
      minTouchGap,
      maxTouchGap,
      minSweepAtr,
      maxSweepAtr,
      displacementLookahead
    ].some(value => value === null) ||
    !Number.isInteger(atrPeriod) ||
    !Number.isInteger(minTouches) ||
    !Number.isInteger(minTouchGap) ||
    !Number.isInteger(maxTouchGap) ||
    !Number.isInteger(displacementLookahead) ||
    minTouches < 2 ||
    maxTouchGap < minTouchGap ||
    maxSweepAtr < minSweepAtr
  ) {
    return null;
  }

  return {
    atrPeriod,
    toleranceAtr,
    minTouches,
    minTouchGap,
    maxTouchGap,
    minSweepAtr,
    maxSweepAtr,
    displacementLookahead
  };
}

function getSwingATR(candles, index, period) {
  return calculateATR(
    candles.slice(0, index + 1),
    period
  );
}

function buildLiquidityClusters(swings, candles, config) {
  const clusters = [];

  const sortedSwings = [...swings].sort(
    (a, b) => a.index - b.index
  );

  let currentCluster = [];

  for (const swing of sortedSwings) {
    const previous = currentCluster[currentCluster.length - 1];

    if (!previous) {
      currentCluster.push(swing);
      continue;
    }

    const gap = swing.index - previous.index;

    const clusterPrices = currentCluster.map(
      item => item.price
    );

    const clusterLevel = clusterPrices.reduce(
      (sum, price) => sum + price,
      0
    ) / clusterPrices.length;

    const atr = getSwingATR(
      candles,
      swing.index,
      config.atrPeriod
    );

    if (!Number.isFinite(atr) || atr <= 0) {
      if (currentCluster.length >= config.minTouches) {
        clusters.push(currentCluster);
      }

      currentCluster = [swing];
      continue;
    }

    const tolerance = atr * config.toleranceAtr;

    const withinTolerance = Math.abs(
      swing.price - clusterLevel
    ) <= tolerance;

    const withinTimeGap = (
      gap >= config.minTouchGap &&
      gap <= config.maxTouchGap
    );

    if (withinTolerance && withinTimeGap) {
      currentCluster.push(swing);
    } else {
      if (currentCluster.length >= config.minTouches) {
        clusters.push(currentCluster);
      }

      currentCluster = [swing];
    }
  }

  if (currentCluster.length >= config.minTouches) {
    clusters.push(currentCluster);
  }

  return clusters;
}

function detectLiquidityDisplacement(
  candles,
  sweepIndex,
  direction,
  config
) {
  const endIndex = Math.min(
    candles.length - 1,
    sweepIndex + config.displacementLookahead
  );

  for (let i = sweepIndex + 1; i <= endIndex; i++) {
    const candle = candles[i];

    if (!isValidCandle(candle)) continue;

    const atr = getSwingATR(
      candles,
      i,
      config.atrPeriod
    );

    if (!Number.isFinite(atr) || atr <= 0) continue;

    if (
      detectDisplacement(
        candle,
        atr,
        direction
      )
    ) {
      return {
        confirmed: true,
        index: i,
        time: candle.time,
        price: candle.close,
        atr
      };
    }
  }

  return {
    confirmed: false,
    index: null,
    time: null,
    price: null,
    atr: null
  };
}

function detectClusterSweep(
  candles,
  cluster,
  type,
  config
) {
  const touchPrices = cluster.map(
    swing => swing.price
  );

  const level = touchPrices.reduce(
    (sum, price) => sum + price,
    0
  ) / touchPrices.length;

  const low = Math.min(...touchPrices);
  const high = Math.max(...touchPrices);

  const lastTouch = cluster[cluster.length - 1];

  const direction = type === "high"
    ? "bearish"
    : "bullish";

  const startIndex = lastTouch.confirmed_index + 1;

  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];

    if (!isValidCandle(candle)) continue;

    const atr = getSwingATR(
      candles,
      i,
      config.atrPeriod
    );

    if (!Number.isFinite(atr) || atr <= 0) continue;

    const penetration = type === "high"
      ? candle.high - level
      : level - candle.low;

    const returnedInside = type === "high"
      ? candle.close < level
      : candle.close > level;

    const validPenetration = (
      penetration >= atr * config.minSweepAtr &&
      penetration <= atr * config.maxSweepAtr
    );

    if (!returnedInside || !validPenetration) {
      continue;
    }

    const displacement = detectLiquidityDisplacement(
      candles,
      i,
      direction,
      config
    );

    return {
      swept: true,
      sweepIndex: i,
      sweepTime: candle.time,
      sweepPrice: type === "high"
        ? candle.high
        : candle.low,
      penetration,
      penetrationAtr: penetration / atr,
      displacementConfirmed: displacement.confirmed,
      displacementIndex: displacement.index,
      displacementTime: displacement.time,
      displacementPrice: displacement.price,
      displacementAtr: displacement.atr
    };
  }

  return {
    swept: false,
    sweepIndex: null,
    sweepTime: null,
    sweepPrice: null,
    penetration: null,
    penetrationAtr: null,
    displacementConfirmed: false,
    displacementIndex: null,
    displacementTime: null,
    displacementPrice: null,
    displacementAtr: null
  };
}

function createLiquidityPyramid(
  cluster,
  candles,
  type,
  config
) {
  const touches = cluster.map(swing => ({
    index: swing.index,
    time: candles[swing.index].time,
    price: swing.price,
    confirmedIndex: swing.confirmed_index,
    confirmedTime: swing.confirmed_time
  }));

  const prices = touches.map(touch => touch.price);

  const level = prices.reduce(
    (sum, price) => sum + price,
    0
  ) / prices.length;

  const low = Math.min(...prices);
  const high = Math.max(...prices);

  const firstTouch = touches[0];
  const lastTouch = touches[touches.length - 1];

  const atr = getSwingATR(
    candles,
    lastTouch.index,
    config.atrPeriod
  );

  const direction = type === "high"
    ? "bearish"
    : "bullish";

  const sweep = detectClusterSweep(
    candles,
    cluster,
    type,
    config
  );

  return {
    type,
    direction,
    index: lastTouch.index,
    startIndex: firstTouch.index,
    endIndex: lastTouch.index,
    level,
    low,
    high,
    width: high - low,
    touchCount: touches.length,
    touches,
    atr,
    confirmedIndex: lastTouch.confirmedIndex,
    confirmedTime: lastTouch.confirmedTime,
    confirmed: true,
    swept: sweep.swept,
    sweepIndex: sweep.sweepIndex,
    sweepTime: sweep.sweepTime,
    sweepPrice: sweep.sweepPrice,
    penetration: sweep.penetration,
    penetrationAtr: sweep.penetrationAtr,
    displacementConfirmed: sweep.displacementConfirmed,
    displacementIndex: sweep.displacementIndex,
    displacementTime: sweep.displacementTime,
    displacementPrice: sweep.displacementPrice,
    displacementAtr: sweep.displacementAtr
  };
}

export function detectLiquidityPyramids(
  candles,
  swings
) {
  if (
    !Array.isArray(candles) ||
    !swings ||
    !Array.isArray(swings.highs) ||
    !Array.isArray(swings.lows)
  ) {
    return {
      buySide: [],
      sellSide: []
    };
  }

  const config = getLiquidityConfig();

  if (!config) {
    return {
      buySide: [],
      sellSide: []
    };
  }

  const highClusters = buildLiquidityClusters(
    swings.highs,
    candles,
    config
  );

  const lowClusters = buildLiquidityClusters(
    swings.lows,
    candles,
    config
  );

  const buySide = highClusters.map(cluster =>
    createLiquidityPyramid(
      cluster,
      candles,
      "high",
      config
    )
  );

  const sellSide = lowClusters.map(cluster =>
    createLiquidityPyramid(
      cluster,
      candles,
      "low",
      config
    )
  );

  return {
    buySide: buySide.sort(
      (a, b) => b.endIndex - a.endIndex
    ),
    sellSide: sellSide.sort(
      (a, b) => b.endIndex - a.endIndex
    )
  };
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
    return {
      highs: [],
      lows: [],
      liquidityPyramids: {
        buySide: [],
        sellSide: []
      }
    };
  }

  const atrPeriod = getConfigNumber(
    "LIQUIDITY_ATR_PERIOD",
    1
  );

  const minDistance = getConfigNumber(
    "MIN_CANDLES_BETWEEN_PIVOTS",
    1
  );

  const minDifference = getConfigNumber(
    "MIN_LEVEL_DIFF_PERCENT"
  );

  if (
    !Number.isInteger(atrPeriod) ||
    minDistance === null ||
    minDifference === null
  ) {
    return {
      highs: [],
      lows: [],
      liquidityPyramids: {
        buySide: [],
        sellSide: []
      }
    };
  }

  const rawSwings = [];

  for (
    let i = left;
    i < candles.length - right;
    i++
  ) {
    const pivot = detectPivot(
      candles,
      i,
      left,
      right
    );

    if (!pivot) continue;

    const atr = getSwingATR(
      candles,
      i,
      atrPeriod
    );

    if (!Number.isFinite(atr) || atr <= 0) {
      continue;
    }

    rawSwings.push({
      ...pivot,
      atr
    });
  }

  const filtered = filterAlternatingSwings(
    rawSwings,
    minDistance,
    minDifference
  );

  const result = {
    highs: filtered.filter(
      swing => swing.type === "high"
    ),
    lows: filtered.filter(
      swing => swing.type === "low"
    )
  };

  result.liquidityPyramids = detectLiquidityPyramids(
    candles,
    result
  );

  return result;
}

export function getLatestMinorSwings(
  swings,
  count = CONFIG.MINOR_SWING_COUNT
) {
  if (!Number.isInteger(count) || count < 1) {
    return {
      highs: [],
      lows: []
    };
  }

  return {
    highs: Array.isArray(swings?.highs)
      ? swings.highs.slice(-count)
      : [],
    lows: Array.isArray(swings?.lows)
      ? swings.lows.slice(-count)
      : []
  };
}

export function getConfirmedSwings(swings, currentIndex) {
  if (
    !swings ||
    !Number.isInteger(currentIndex) ||
    currentIndex < 0
  ) {
    return {
      highs: [],
      lows: []
    };
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
      swing.confirmed_index > swing.index &&
      swing.confirmed_index <= currentIndex &&
      (
        swing.confirmed_time === undefined ||
        Number.isFinite(swing.confirmed_time)
      )
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

  const minDistance = getConfigNumber(
    "MIN_SWING_DISTANCE",
    1
  );

  const minDifference = getConfigNumber(
    "MIN_LEVEL_DIFF_PERCENT"
  );

  if (
    minDistance === null ||
    minDifference === null ||
    swingB.index - swingA.index < minDistance ||
    getPercentDifference(
      swingA.price,
      swingB.price
    ) < minDifference
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

  return {
    slope,
    intercept
  };
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
    !trendline ||
    !Number.isInteger(startIndex) ||
    startIndex < 1 ||
    startIndex >= candles.length ||
    !["bullish", "bearish"].includes(lineDirection)
  ) {
    return null;
  }

  const atrPeriod = getSafeOption(
    options,
    "atrPeriod",
    "ATR_PERIOD",
    1
  );

  const minBodyRatio = getSafeOption(
    options,
    "minBodyRatio",
    "BREAKOUT_MIN_BODY_RATIO"
  );

  const minClosePosition = getSafeOption(
    options,
    "minClosePosition",
    "BREAKOUT_MIN_CLOSE_POSITION"
  );

  const breakoutBufferAtr = getSafeOption(
    options,
    "breakoutBufferAtr",
    "BREAKOUT_BUFFER_ATR"
  );

  const minBodyAtr = getSafeOption(
    options,
    "minBodyAtr",
    "BREAKOUT_MIN_BODY_ATR"
  );

  if (
    [
      atrPeriod,
      minBodyRatio,
      minClosePosition,
      breakoutBufferAtr,
      minBodyAtr
    ].some(value => value === null) ||
    !Number.isInteger(atrPeriod) ||
    minBodyRatio > 1 ||
    minClosePosition < 0.5 ||
    minClosePosition > 1
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
        bodyRatio * CONFIG.BREAKOUT_BODY_STRENGTH_WEIGHT +
        Math.min(
          body / atr,
          CONFIG.BREAKOUT_MAX_BODY_ATR
        ) * CONFIG.BREAKOUT_ATR_STRENGTH_WEIGHT,
        CONFIG.STRENGTH_MIN,
        CONFIG.STRENGTH_MAX
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
      bodyRatio >= CONFIG.REJECTION_MIN_BODY_RATIO &&
      closePosition >= CONFIG.BULLISH_REJECTION_CLOSE_POSITION &&
      lowerWick / range >= CONFIG.REJECTION_MIN_WICK_RATIO
    );
  }

  if (direction === "bearish") {
    return (
      isBear(candle) &&
      bodyRatio >= CONFIG.REJECTION_MIN_BODY_RATIO &&
      closePosition <= CONFIG.BEARISH_REJECTION_CLOSE_POSITION &&
      upperWick / range >= CONFIG.REJECTION_MIN_WICK_RATIO
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
    "PULLBACK_MIN_MOVE_AWAY_ZONE"
  );

  const minMoveAwayAtr = getSafeOption(
    options,
    "minMoveAwayAtr",
    "PULLBACK_MIN_MOVE_AWAY_ATR"
  );

  const atrPeriod = getSafeOption(
    options,
    "atrPeriod",
    "ATR_PERIOD",
    1
  );

  if (
    minMoveAwayZone === null ||
    minMoveAwayAtr === null ||
    atrPeriod === null ||
    !Number.isInteger(atrPeriod)
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

  for (let i = startIndex + 1; i <= endIndex; i++) {
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

  const minBodyAtr = getSafeOption(
    options,
    "minBodyAtr",
    "DISPLACEMENT_MIN_BODY_ATR"
  );

  const minBodyRatio = getSafeOption(
    options,
    "minBodyRatio",
    "DISPLACEMENT_MIN_BODY_RATIO"
  );

  const minClosePosition = getSafeOption(
    options,
    "minClosePosition",
    "DISPLACEMENT_MIN_CLOSE_POSITION"
  );

  if (
    minBodyAtr === null ||
    minBodyRatio === null ||
    minClosePosition === null ||
    minBodyRatio > 1 ||
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

  const maxBaseCandles = getSafeOption(
    options,
    "maxBaseCandles",
    "BASE_MAX_CANDLES",
    1
  );

  const minBaseCandles = getSafeOption(
    options,
    "minBaseCandles",
    "BASE_MIN_CANDLES",
    1
  );

  const maxRangeAtr = getSafeOption(
    options,
    "maxBaseRangeAtr",
    "BASE_MAX_RANGE_ATR"
  );

  const maxBodyAtr = getSafeOption(
    options,
    "maxBaseBodyAtr",
    "BASE_MAX_BODY_ATR"
  );

  if (
    maxBaseCandles === null ||
    minBaseCandles === null ||
    maxRangeAtr === null ||
    maxBodyAtr === null ||
    !Number.isInteger(maxBaseCandles) ||
    !Number.isInteger(minBaseCandles) ||
    maxBaseCandles < minBaseCandles
  ) {
    return null;
  }

  const base = [];

  for (
    let i = endIndex;
    i >= Math.max(
      0,
      endIndex - maxBaseCandles + 1
    );
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

  const candlesInBase = base.map(
    item => item.candle
  );

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
    !["bullish", "bearish"].includes(direction)
  ) {
    return [];
  }

  const atrPeriod = getSafeOption(
    options,
    "atrPeriod",
    "ATR_PERIOD",
    1
  );

  const maxAge = getSafeOption(
    options,
    "maxAge",
    "ZONE_MAX_AGE",
    1
  );

  const maxResults = getSafeOption(
    options,
    "maxResults",
    "ZONE_MAX_RESULTS",
    1
  );

  const maxZoneAtr = getSafeOption(
    options,
    "maxZoneAtr",
    "ZONE_MAX_WIDTH_ATR"
  );

  if (
    atrPeriod === null ||
    maxAge === null ||
    maxResults === null ||
    maxZoneAtr === null ||
    !Number.isInteger(atrPeriod) ||
    !Number.isInteger(maxAge) ||
    !Number.isInteger(maxResults)
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

    if (!detectDisplacement(displacement, atr, direction, options)) {
      continue;
    }

    const base = detectBase(
      candles,
      i - 1,
      atr,
      options
    );

    if (!base || base.endIndex !== i - 1) {
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

    const displacementStrength = cBody(displacement) / atr;

    const compactnessRangeAtr = getConfigNumber(
      "BASE_COMPACTNESS_RANGE_ATR"
    );

    const compactnessWeight = getConfigNumber(
      "BASE_COMPACTNESS_WEIGHT"
    );

    const displacementWeight = getConfigNumber(
      "ZONE_DISPLACEMENT_STRENGTH_WEIGHT"
    );

    const candleCountWeight = getConfigNumber(
      "ZONE_BASE_CANDLE_WEIGHT"
    );

    const maxStrength = getConfigNumber(
      "STRENGTH_MAX"
    );

    if (
      compactnessRangeAtr === null ||
      compactnessRangeAtr <= 0 ||
      compactnessWeight === null ||
      displacementWeight === null ||
      candleCountWeight === null ||
      maxStrength === null
    ) {
      continue;
    }

    const baseCompactness = 1 - clamp(
      base.width / (atr * compactnessRangeAtr),
      0,
      1
    );

    const strength = clamp(
      displacementStrength * displacementWeight +
      baseCompactness * compactnessWeight +
      Math.min(
        base.candleCount,
        CONFIG.BASE_STRENGTH_CANDLE_CAP
      ) * candleCountWeight,
      CONFIG.STRENGTH_MIN,
      maxStrength
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

  const maxBars = getSafeOption(
    options,
    "maxBars",
    "ZONE_RETEST_MAX_BARS",
    1
  );

  const tolerance = getSafeOption(
    options,
    "tolerancePercent",
    "ZONE_RETEST_TOLERANCE_PERCENT"
  );

  if (
    maxBars === null ||
    tolerance === null ||
    !Number.isInteger(maxBars)
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

  for (let i = startIndex + 1; i <= endIndex; i++) {
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

  const confirmationBars = getSafeOption(
    options,
    "confirmationBars",
    "ZONE_CONFIRMATION_BARS",
    1
  );

  if (
    confirmationBars === null ||
    !Number.isInteger(confirmationBars)
  ) {
    return null;
  }

  const midpoint = (zone.low + zone.high) / 2;

  const endIndex = Math.min(
    candles.length - 1,
    retestIndex + confirmationBars
  );

  for (let i = retestIndex + 1; i <= endIndex; i++) {
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

export function calculateEMA(
  candles,
  period = CONFIG.EMA_PERIOD
) {
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

  const multiplier = CONFIG.EMA_MULTIPLIER_NUMERATOR /
    (period + CONFIG.EMA_PERIOD_ADJUSTMENT);

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
