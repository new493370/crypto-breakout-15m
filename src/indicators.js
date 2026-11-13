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
  return isValidCandle(c) ? Math.abs(c.close - c.open) : 0;
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

function getConfigNumber(key, min = 0) {
  const value = CONFIG?.[key];

  return Number.isFinite(value) && value >= min
    ? value
    : null;
}

function getSafeOption(options, key, configKey, min = 0) {
  const value = options?.[key] ?? CONFIG?.[configKey];

  return Number.isFinite(value) && value >= min
    ? value
    : null;
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
    if (!isValidCandle(candles[i])) return false;

    if (
      i > startIndex &&
      candles[i].time <= candles[i - 1].time
    ) {
      return false;
    }
  }

  return true;
}

function getTrueRange(current, previous) {
  if (
    !isValidCandle(current) ||
    !isValidCandle(previous) ||
    current.time <= previous.time
  ) {
    return null;
  }

  const value = Math.max(
    current.high - current.low,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close)
  );

  return Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function calculateATR(candles, period = CONFIG.ATR_PERIOD) {
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
    const tr = getTrueRange(candles[i], candles[i - 1]);

    if (tr === null) {
      atr = null;
      seedSum = 0;
      seedCount = 0;
      continue;
    }

    if (atr === null) {
      seedSum += tr;
      seedCount++;

      if (seedCount === period) {
        atr = seedSum / period;
      }

      continue;
    }

    atr = (atr * (period - 1) + tr) / period;
  }

  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

function getATRAt(candles, index, period) {
  if (
    !Array.isArray(candles) ||
    !Number.isInteger(index) ||
    index < 1 ||
    index >= candles.length
  ) {
    return null;
  }

  return calculateATR(candles.slice(0, index + 1), period);
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

    if (candle.high > current.high) {
      isHigh = false;
    } else if (candle.high === current.high) {
      if (i > index) isHigh = false;
    }

    if (candle.low < current.low) {
      isLow = false;
    } else if (candle.low === current.low) {
      if (i > index) isLow = false;
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

function filterAlternatingSwings(swings, minDistance, minDifference) {
  if (!Array.isArray(swings) || swings.length === 0) {
    return [];
  }

  const distance = Number.isFinite(minDistance)
    ? Math.max(1, minDistance)
    : 1;

  const difference = Number.isFinite(minDifference)
    ? Math.max(0, minDifference)
    : 0;

  const sorted = [...swings]
    .filter(item =>
      item &&
      (item.type === "high" || item.type === "low") &&
      Number.isInteger(item.index) &&
      Number.isFinite(item.price) &&
      item.price > 0
    )
    .sort((a, b) => a.index - b.index);

  const result = [];

  for (const current of sorted) {
    const last = result[result.length - 1];

    if (!last) {
      result.push(current);
      continue;
    }

    if (current.index <= last.index) continue;

    if (current.type === last.type) {
      const moreExtreme = current.type === "high"
        ? current.price > last.price
        : current.price < last.price;

      if (!moreExtreme) continue;

      const previous = result[result.length - 2];

      if (previous) {
        const enoughDistance =
          current.index - previous.index >= distance;

        const enoughDifference =
          getPercentDifference(previous.price, current.price) >= difference;

        if (!enoughDistance || !enoughDifference) {
          continue;
        }
      }

      result[result.length - 1] = current;
      continue;
    }

    const enoughDistance =
      current.index - last.index >= distance;

    const enoughDifference =
      getPercentDifference(last.price, current.price) >= difference;

    if (!enoughDistance || !enoughDifference) {
      continue;
    }

    result.push(current);
  }

  return result;
}

function getLiquidityConfig() {
  const config = {
    atrPeriod: getConfigNumber("LIQUIDITY_ATR_PERIOD", 1),
    toleranceAtr: getConfigNumber("LIQUIDITY_CLUSTER_TOLERANCE_ATR"),
    minTouches: getConfigNumber("LIQUIDITY_MIN_TOUCHES", 2),
    minTouchGap: getConfigNumber("LIQUIDITY_MIN_TOUCH_GAP", 1),
    maxTouchGap: getConfigNumber("LIQUIDITY_MAX_TOUCH_GAP", 1),
    maxAge: getConfigNumber("LIQUIDITY_MAX_AGE", 1),
    maxResults: getConfigNumber("LIQUIDITY_MAX_RESULTS", 1),
    minSweepAtr: getConfigNumber("LIQUIDITY_SWEEP_MIN_ATR"),
    maxSweepAtr: getConfigNumber("LIQUIDITY_SWEEP_MAX_ATR"),
    sweepLookahead: getConfigNumber("LIQUIDITY_SWEEP_LOOKAHEAD_BARS", 1),
    displacementLookahead: getConfigNumber(
      "LIQUIDITY_DISPLACEMENT_LOOKAHEAD_BARS",
      1
    )
  };

  if (
    Object.values(config).some(value => value === null) ||
    !Number.isInteger(config.atrPeriod) ||
    !Number.isInteger(config.minTouches) ||
    !Number.isInteger(config.minTouchGap) ||
    !Number.isInteger(config.maxTouchGap) ||
    !Number.isInteger(config.maxAge) ||
    !Number.isInteger(config.maxResults) ||
    !Number.isInteger(config.sweepLookahead) ||
    !Number.isInteger(config.displacementLookahead) ||
    config.maxTouchGap < config.minTouchGap ||
    config.maxSweepAtr < config.minSweepAtr
  ) {
    return null;
  }

  return config;
}

function buildLiquidityClusters(swings, candles, config) {
  const clusters = [];
  const sorted = [...swings].sort((a, b) => a.index - b.index);

  let cluster = [];

  const saveCluster = () => {
    if (cluster.length >= config.minTouches) {
      clusters.push(cluster);
    }
  };

  for (const swing of sorted) {
    const last = cluster[cluster.length - 1];

    if (!last) {
      cluster = [swing];
      continue;
    }

    const gap = swing.index - last.index;
    const atr = getATRAt(candles, swing.index, config.atrPeriod);

    if (!Number.isFinite(atr) || atr <= 0) {
      saveCluster();
      cluster = [swing];
      continue;
    }

    const averagePrice = cluster.reduce(
      (sum, item) => sum + item.price,
      0
    ) / cluster.length;

    const withinPrice = Math.abs(swing.price - averagePrice) <=
      atr * config.toleranceAtr;

    const withinGap = gap >= config.minTouchGap &&
      gap <= config.maxTouchGap;

    if (withinPrice && withinGap) {
      cluster.push(swing);
    } else {
      saveCluster();
      cluster = [swing];
    }
  }

  saveCluster();

  const latestIndex = candles.length - 1;

  return clusters.filter(items => {
    const last = items[items.length - 1];

    return latestIndex - last.index <= config.maxAge;
  });
}

function detectDisplacement(candle, atr, direction, options = {}) {
  if (
    !isValidCandle(candle) ||
    !Number.isFinite(atr) ||
    atr <= 0
  ) {
    return false;
  }

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

  const range = cRange(candle);

  if (range <= 0) return false;

  const bodyRatio = cBody(candle) / range;
  const closePosition = (cClose(candle) - cLow(candle)) / range;

  if (
    cBody(candle) < atr * minBodyAtr ||
    bodyRatio < minBodyRatio
  ) {
    return false;
  }

  if (direction === "bullish") {
    return isBull(candle) && closePosition >= minClosePosition;
  }

  if (direction === "bearish") {
    return isBear(candle) &&
      closePosition <= 1 - minClosePosition;
  }

  return false;
}

function detectLiquidityDisplacement(candles, sweepIndex, direction, config) {
  const endIndex = Math.min(
    candles.length - 1,
    sweepIndex + config.displacementLookahead
  );

  for (let i = sweepIndex + 1; i <= endIndex; i++) {
    const candle = candles[i];

    if (!isValidCandle(candle)) continue;

    const atr = getATRAt(candles, i, config.atrPeriod);

    if (!Number.isFinite(atr) || atr <= 0) continue;

    if (detectDisplacement(candle, atr, direction)) {
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

function detectClusterSweep(candles, cluster, type, config) {
  const prices = cluster.map(item => item.price);

  const level = prices.reduce((sum, price) => sum + price, 0) /
    prices.length;

  const lastTouch = cluster[cluster.length - 1];
  const startIndex = lastTouch.confirmed_index + 1;

  const endIndex = Math.min(
    candles.length - 1,
    startIndex + config.sweepLookahead - 1
  );

  const direction = type === "high" ? "bearish" : "bullish";

  for (let i = startIndex; i <= endIndex; i++) {
    const candle = candles[i];

    if (!isValidCandle(candle)) continue;

    const atr = getATRAt(candles, i, config.atrPeriod);

    if (!Number.isFinite(atr) || atr <= 0) continue;

    const penetration = type === "high"
      ? candle.high - level
      : level - candle.low;

    const returnedInside = type === "high"
      ? candle.close < level
      : candle.close > level;

    if (
      !returnedInside ||
      penetration < atr * config.minSweepAtr ||
      penetration > atr * config.maxSweepAtr
    ) {
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
      sweepPrice: type === "high" ? candle.high : candle.low,
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

function createLiquidityPyramid(cluster, candles, type, config) {
  const touches = cluster.map(swing => ({
    index: swing.index,
    time: candles[swing.index].time,
    price: swing.price,
    confirmedIndex: swing.confirmed_index,
    confirmedTime: swing.confirmed_time
  }));

  const prices = touches.map(item => item.price);

  const level = prices.reduce((sum, price) => sum + price, 0) /
    prices.length;

  const firstTouch = touches[0];
  const lastTouch = touches[touches.length - 1];

  const sweep = detectClusterSweep(candles, cluster, type, config);

  return {
    type,
    direction: type === "high" ? "bearish" : "bullish",
    index: lastTouch.index,
    startIndex: firstTouch.index,
    endIndex: lastTouch.index,
    level,
    low: Math.min(...prices),
    high: Math.max(...prices),
    width: Math.max(...prices) - Math.min(...prices),
    touchCount: touches.length,
    touches,
    atr: getATRAt(candles, lastTouch.index, config.atrPeriod),
    confirmedIndex: lastTouch.confirmedIndex,
    confirmedTime: lastTouch.confirmedTime,
    confirmed: true,
    ...sweep
  };
}

export function detectLiquidityPyramids(candles, swings) {
  const empty = { buySide: [], sellSide: [] };

  if (
    !Array.isArray(candles) ||
    !swings ||
    !Array.isArray(swings.highs) ||
    !Array.isArray(swings.lows)
  ) {
    return empty;
  }

  const config = getLiquidityConfig();

  if (!config) return empty;

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

  const buySide = highClusters
    .map(cluster => createLiquidityPyramid(
      cluster,
      candles,
      "high",
      config
    ))
    .sort((a, b) => b.endIndex - a.endIndex)
    .slice(0, config.maxResults);

  const sellSide = lowClusters
    .map(cluster => createLiquidityPyramid(
      cluster,
      candles,
      "low",
      config
    ))
    .sort((a, b) => b.endIndex - a.endIndex)
    .slice(0, config.maxResults);

  return { buySide, sellSide };
}

export function detectSwings(
  candles,
  left = CONFIG.SWING_LEFT,
  right = CONFIG.SWING_RIGHT
) {
  const empty = {
    highs: [],
    lows: [],
    rawHighs: [],
    rawLows: [],
    liquidityPyramids: {
      buySide: [],
      sellSide: []
    }
  };

  if (
    !Array.isArray(candles) ||
    !Number.isInteger(left) ||
    !Number.isInteger(right) ||
    left < 1 ||
    right < 1 ||
    candles.length < left + right + 1
  ) {
    return empty;
  }

  const atrPeriod = getConfigNumber("LIQUIDITY_ATR_PERIOD", 1);
  const minDistance = getConfigNumber(
    "MIN_CANDLES_BETWEEN_PIVOTS",
    1
  );
  const minDifference = getConfigNumber("MIN_LEVEL_DIFF_PERCENT");

  if (
    !Number.isInteger(atrPeriod) ||
    minDistance === null ||
    minDifference === null
  ) {
    return empty;
  }

  const rawSwings = [];
  const startIndex = Math.max(left, atrPeriod + 1);

  for (let i = startIndex; i < candles.length - right; i++) {
    const pivot = detectPivot(candles, i, left, right);

    if (!pivot) continue;

    const atr = getATRAt(candles, i, atrPeriod);

    if (!Number.isFinite(atr) || atr <= 0) continue;

    rawSwings.push({ ...pivot, atr });
  }

  const filtered = filterAlternatingSwings(
    rawSwings,
    minDistance,
    minDifference
  );

  const rawHighs = rawSwings.filter(item => item.type === "high");
  const rawLows = rawSwings.filter(item => item.type === "low");

  const result = {
    highs: filtered.filter(item => item.type === "high"),
    lows: filtered.filter(item => item.type === "low"),
    rawHighs,
    rawLows
  };

  result.liquidityPyramids = detectLiquidityPyramids(
    candles,
    {
      highs: rawHighs,
      lows: rawLows
    }
  );

  return result;
}

export function getLatestMinorSwings(
  swings,
  count = CONFIG.LATEST_MINOR_SWING_COUNT
) {
  if (!Number.isInteger(count) || count < 1) {
    return { highs: [], lows: [] };
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
    return { highs: [], lows: [] };
  }

  const filter = (list, type) => {
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
    highs: filter(swings.highs, "high"),
    lows: filter(swings.lows, "low")
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

  const minDistance = getConfigNumber("MIN_SWING_DISTANCE", 1);
  const minDifference = getConfigNumber("MIN_LEVEL_DIFF_PERCENT");

  if (
    minDistance === null ||
    minDifference === null ||
    swingB.index - swingA.index < minDistance ||
    getPercentDifference(swingA.price, swingB.price) < minDifference
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

  return Number.isFinite(price) && price > 0 ? price : null;
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

  const atrPeriod = getSafeOption(options, "atrPeriod", "ATR_PERIOD", 1);
  const minBodyRatio = getSafeOption(options, "minBodyRatio", "BREAKOUT_MIN_BODY_RATIO");
  const minClosePosition = getSafeOption(options, "minClosePosition", "BREAKOUT_MIN_CLOSE_POSITION");
  const breakoutBufferAtr = getSafeOption(options, "breakoutBufferAtr", "BREAKOUT_BUFFER_ATR");
  const minBodyAtr = getSafeOption(options, "minBodyAtr", "BREAKOUT_MIN_BODY_ATR");
  const bodyStrengthWeight = getSafeOption(options, "bodyStrengthWeight", "BREAKOUT_BODY_STRENGTH_WEIGHT");
  const atrStrengthWeight = getSafeOption(options, "atrStrengthWeight", "BREAKOUT_ATR_STRENGTH_WEIGHT");
  const maxBodyAtr = getSafeOption(options, "maxBodyAtr", "BREAKOUT_MAX_BODY_ATR", 0.000001);
  const confirmationBars = getSafeOption(options, "confirmationBars", "BREAKOUT_CONFIRMATION_BARS", 1);

  const totalWeight = bodyStrengthWeight + atrStrengthWeight;

  if (
    atrPeriod === null ||
    minBodyRatio === null ||
    minClosePosition === null ||
    breakoutBufferAtr === null ||
    minBodyAtr === null ||
    bodyStrengthWeight === null ||
    atrStrengthWeight === null ||
    maxBodyAtr === null ||
    confirmationBars === null ||
    !Number.isInteger(atrPeriod) ||
    !Number.isInteger(confirmationBars) ||
    confirmationBars < 1 ||
    minBodyRatio > 1 ||
    minClosePosition < 0.5 ||
    minClosePosition > 1 ||
    maxBodyAtr < minBodyAtr ||
    totalWeight <= 0
  ) {
    return null;
  }

  const lastCandidateIndex = candles.length - confirmationBars;

  let latestBreakout = null;

  for (let i = startIndex; i <= lastCandidateIndex; i++) {
    if (
      !isValidTimeSequence(
        candles,
        i - 1,
        i + confirmationBars - 1
      )
    ) {
      continue;
    }

    const candle = candles[i];
    const previous = candles[i - 1];

    const previousLine = getTrendlinePrice(trendline, i - 1);
    const currentLine = getTrendlinePrice(trendline, i);

    if (previousLine === null || currentLine === null) continue;

    const atr = getATRAt(candles, i, atrPeriod);

    if (!Number.isFinite(atr) || atr <= 0) continue;

    const range = cRange(candle);

    if (range <= 0) continue;

    const body = cBody(candle);
    const bodyRatio = body / range;
    const closePosition = (candle.close - candle.low) / range;
    const buffer = atr * breakoutBufferAtr;

    let direction = null;

    if (
      lineDirection === "bearish" &&
      previous.close <= previousLine &&
      candle.close > currentLine + buffer &&
      isBull(candle) &&
      bodyRatio >= minBodyRatio &&
      body >= atr * minBodyAtr &&
      closePosition >= minClosePosition
    ) {
      direction = "bullish";
    } else if (
      lineDirection === "bullish" &&
      previous.close >= previousLine &&
      candle.close < currentLine - buffer &&
      isBear(candle) &&
      bodyRatio >= minBodyRatio &&
      body >= atr * minBodyAtr &&
      closePosition <= 1 - minClosePosition
    ) {
      direction = "bearish";
    }

    if (!direction) continue;

    let confirmed = true;

    for (let j = i + 1; j < i + confirmationBars; j++) {
      const confirmationCandle = candles[j];
      const confirmationLine = getTrendlinePrice(trendline, j);

      if (
        !isValidCandle(confirmationCandle) ||
        confirmationLine === null ||
        (
          direction === "bullish"
            ? confirmationCandle.close <= confirmationLine + buffer
            : confirmationCandle.close >= confirmationLine - buffer
        )
      ) {
        confirmed = false;
        break;
      }
    }

    if (!confirmed) continue;

    const bodyStrength = clamp(bodyRatio, 0, 1);
    const atrStrength = clamp(body / (atr * maxBodyAtr), 0, 1);

    const strength = (
      bodyStrength * bodyStrengthWeight +
      atrStrength * atrStrengthWeight
    ) / totalWeight;

    latestBreakout = {
      index: i,
      direction,
      lineDirection,
      candle,
      zoneLow: candle.low,
      zoneHigh: candle.high,
      zoneWidth: range,
      linePrice: currentLine,
      atr,
      strength: clamp(strength, 0, 1),
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

  const bodyRatio = cBody(candle) / range;
  const closePosition = (candle.close - candle.low) / range;

  const minBodyRatio = getConfigNumber("REJECTION_MIN_BODY_RATIO");
  const minWickRatio = getConfigNumber("REJECTION_MIN_WICK_RATIO");
  const bullishClosePosition = getConfigNumber(
    "BULLISH_REJECTION_CLOSE_POSITION"
  );
  const bearishClosePosition = getConfigNumber(
    "BEARISH_REJECTION_CLOSE_POSITION"
  );

  if (
    minBodyRatio === null ||
    minWickRatio === null ||
    bullishClosePosition === null ||
    bearishClosePosition === null ||
    minBodyRatio > 1 ||
    minWickRatio > 1 ||
    bullishClosePosition > 1 ||
    bearishClosePosition > 1
  ) {
    return false;
  }

  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;

  if (direction === "bullish") {
    return (
      isBull(candle) &&
      bodyRatio >= minBodyRatio &&
      lowerWick / range >= minWickRatio &&
      closePosition >= bullishClosePosition
    );
  }

  if (direction === "bearish") {
    return (
      isBear(candle) &&
      bodyRatio >= minBodyRatio &&
      upperWick / range >= minWickRatio &&
      closePosition <= bearishClosePosition
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

  const atrPeriod = getSafeOption(options, "atrPeriod", "ATR_PERIOD", 1);
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

  if (
    atrPeriod === null ||
    minMoveAwayZone === null ||
    minMoveAwayAtr === null ||
    !Number.isInteger(atrPeriod)
  ) {
    return null;
  }

  const atr = getATRAt(candles, startIndex, atrPeriod);

  if (!Number.isFinite(atr) || atr <= 0) return null;

  const minimumMove = Math.max(
    (zoneHigh - zoneLow) * minMoveAwayZone,
    atr * minMoveAwayAtr
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

    const touched = candle.low <= zoneHigh &&
      candle.high >= zoneLow;

    if (!touched || !getCandleRejection(candle, direction)) {
      continue;
    }

    return {
      index: i,
      candle,
      entryPrice: candle.close,
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

function detectBase(candles, endIndex, atr, options = {}) {
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

  const maxCandles = getSafeOption(
    options,
    "maxBaseCandles",
    "BASE_MAX_CANDLES",
    1
  );

  const minCandles = getSafeOption(
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
    maxCandles === null ||
    minCandles === null ||
    maxRangeAtr === null ||
    maxBodyAtr === null ||
    !Number.isInteger(maxCandles) ||
    !Number.isInteger(minCandles) ||
    maxCandles < minCandles
  ) {
    return null;
  }

  const base = [];

  for (
    let i = endIndex;
    i >= Math.max(0, endIndex - maxCandles + 1);
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

    base.unshift({ index: i, candle });
  }

  if (base.length < minCandles) return null;

  const baseCandles = base.map(item => item.candle);

  const low = Math.min(...baseCandles.map(c => c.low));
  const high = Math.max(...baseCandles.map(c => c.high));

  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
    return null;
  }

  return {
    startIndex: base[0].index,
    endIndex: base[base.length - 1].index,
    low,
    high,
    width: high - low,
    candleCount: base.length,
    candles: baseCandles
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
    "SUPPLY_DEMAND_ATR_PERIOD",
    1
  );
  const maxAge = getSafeOption(
    options,
    "maxAge",
    "SUPPLY_DEMAND_MAX_AGE",
    1
  );
  const maxResults = getSafeOption(
    options,
    "maxResults",
    "SUPPLY_DEMAND_MAX_RESULTS",
    1
  );
  const maxZoneAtr = getSafeOption(
    options,
    "maxZoneAtr",
    "SUPPLY_DEMAND_MAX_ZONE_ATR"
  );

  const compactnessRangeAtr = getConfigNumber(
    "BASE_COMPACTNESS_RANGE_ATR",
    0.000001
  );
  const compactnessWeight = getConfigNumber("BASE_COMPACTNESS_WEIGHT");
  const displacementWeight = getConfigNumber(
    "ZONE_DISPLACEMENT_STRENGTH_WEIGHT"
  );
  const baseCandleWeight = getConfigNumber("ZONE_BASE_CANDLE_WEIGHT");
  const baseStrengthCandleCap = getConfigNumber(
    "BASE_STRENGTH_CANDLE_CAP",
    1
  );
  const strengthMin = getConfigNumber("STRENGTH_MIN");
  const strengthMax = getConfigNumber("STRENGTH_MAX");

  const totalWeight = compactnessWeight +
    displacementWeight +
    baseCandleWeight;

  if (
    atrPeriod === null ||
    maxAge === null ||
    maxResults === null ||
    maxZoneAtr === null ||
    compactnessRangeAtr === null ||
    compactnessWeight === null ||
    displacementWeight === null ||
    baseCandleWeight === null ||
    baseStrengthCandleCap === null ||
    strengthMin === null ||
    strengthMax === null ||
    !Number.isInteger(atrPeriod) ||
    !Number.isInteger(maxAge) ||
    !Number.isInteger(maxResults) ||
    !Number.isFinite(totalWeight) ||
    totalWeight <= 0 ||
    strengthMax < strengthMin
  ) {
    return [];
  }

  const lastCandle = candles[candles.length - 1];

  if (!isValidCandle(lastCandle)) return [];

  const currentPrice = lastCandle.close;
  const zones = [];
  const startIndex = Math.max(1, candles.length - maxAge);

  for (let i = startIndex; i < candles.length; i++) {
    const displacement = candles[i];

    if (!isValidCandle(displacement)) continue;

    const atr = getATRAt(candles, i, atrPeriod);

    if (!Number.isFinite(atr) || atr <= 0) continue;

    if (!detectDisplacement(displacement, atr, direction, options)) {
      continue;
    }

    const base = detectBase(candles, i - 1, atr, options);

    if (!base || base.endIndex !== i - 1) continue;

    const bullishBaseHigh = Math.max(
      ...base.candles.map(c => Math.max(c.open, c.close))
    );

    const bearishBaseLow = Math.min(
      ...base.candles.map(c => Math.min(c.open, c.close))
    );

    const zoneLow = direction === "bullish"
      ? base.low
      : bearishBaseLow;

    const zoneHigh = direction === "bullish"
      ? bullishBaseHigh
      : base.high;

    const width = zoneHigh - zoneLow;

    if (
      !Number.isFinite(width) ||
      width <= 0 ||
      width > atr * maxZoneAtr
    ) {
      continue;
    }

    const displacementValid = direction === "bullish"
      ? displacement.close > base.high
      : displacement.close < base.low;

    if (!displacementValid) continue;

    const correctSide = direction === "bullish"
      ? currentPrice > zoneHigh
      : currentPrice < zoneLow;

    if (!correctSide) continue;

    let broken = false;

    for (let j = i + 1; j < candles.length; j++) {
      const later = candles[j];

      if (!isValidCandle(later)) continue;

      if (
        direction === "bullish"
          ? later.close < zoneLow
          : later.close > zoneHigh
      ) {
        broken = true;
        break;
      }
    }

    if (broken) continue;

    const displacementStrength = clamp(
      (cBody(displacement) / atr) / 3,
      0,
      1
    );

    const compactness = 1 - clamp(
      width / (atr * compactnessRangeAtr),
      0,
      1
    );

    const baseStrength = clamp(
      base.candleCount / baseStrengthCandleCap,
      0,
      1
    );

    const normalizedStrength = (
      displacementStrength * displacementWeight +
      compactness * compactnessWeight +
      baseStrength * baseCandleWeight
    ) / totalWeight;

    const strength = clamp(
      strengthMin + normalizedStrength * (strengthMax - strengthMin),
      strengthMin,
      strengthMax
    );

    zones.push({
      type: direction === "bullish" ? "demand" : "supply",
      direction,
      low: zoneLow,
      high: zoneHigh,
      width,
      atr,
      strength,
      baseStartIndex: base.startIndex,
      baseEndIndex: base.endIndex,
      displacementIndex: i,
      displacementTime: displacement.time,
      candleCount: base.candleCount,
      distance: Math.max(
        0,
        direction === "bullish"
          ? currentPrice - zoneHigh
          : zoneLow - currentPrice
      ),
      broken: false,
      confirmed: true
    });
  }

  zones.sort((a, b) =>
    b.displacementIndex - a.displacementIndex ||
    b.strength - a.strength
  );

  const uniqueZones = [];

  for (const zone of zones) {
    const overlaps = uniqueZones.some(existing =>
      zone.low <= existing.high &&
      zone.high >= existing.low
    );

    if (!overlaps) uniqueZones.push(zone);

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

  if (!["bullish", "bearish"].includes(direction)) return null;

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

  const toleranceValue = (zone.high - zone.low) * tolerance / 100;

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

    const touched = candle.low <= zone.high + toleranceValue &&
      candle.high >= zone.low - toleranceValue;

    if (!touched || !getCandleRejection(candle, direction)) {
      continue;
    }

    return {
      index: i,
      candle,
      zoneLow: zone.low,
      zoneHigh: zone.high,
      entryPrice: candle.close,
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

  if (!["bullish", "bearish"].includes(direction)) return null;

  const confirmationBars = getSafeOption(
    options,
    "confirmationBars",
    "ZONE_REACTION_CONFIRMATION_BARS",
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

  const multiplier = 2 / (period + 1);

  let ema = closes
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] - ema) * multiplier + ema;
  }

  return Number.isFinite(ema) && ema > 0 ? ema : null;
}
