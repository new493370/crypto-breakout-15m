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
  const period = Math.floor(
    getConfigNumber("ATR_PERIOD", 14, 1)
  );

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

    const trueRange = getTrueRange(
      candles[i],
      previousClose
    );

    if (!Number.isFinite(trueRange)) return null;

    sum += trueRange;
  }

  const atr = sum / period;

  return Number.isFinite(atr) && atr > 0
    ? atr
    : null;
}

function getSwingProminence(
  candles,
  index,
  left,
  right,
  type
) {
  const current = candles[index];

  if (!isValidCandle(current)) return 0;

  if (type === "high") {
    let leftLowest = Infinity;
    let rightLowest = Infinity;

    for (let i = index - left; i < index; i++) {
      if (!isValidCandle(candles[i])) return 0;

      leftLowest = Math.min(
        leftLowest,
        cLow(candles[i])
      );
    }

    for (let i = index + 1; i <= index + right; i++) {
      if (!isValidCandle(candles[i])) return 0;

      rightLowest = Math.min(
        rightLowest,
        cLow(candles[i])
      );
    }

    return Math.max(
      0,
      Math.min(
        cHigh(current) - leftLowest,
        cHigh(current) - rightLowest
      )
    );
  }

  if (type === "low") {
    let leftHighest = -Infinity;
    let rightHighest = -Infinity;

    for (let i = index - left; i < index; i++) {
      if (!isValidCandle(candles[i])) return 0;

      leftHighest = Math.max(
        leftHighest,
        cHigh(candles[i])
      );
    }

    for (let i = index + 1; i <= index + right; i++) {
      if (!isValidCandle(candles[i])) return 0;

      rightHighest = Math.max(
        rightHighest,
        cHigh(candles[i])
      );
    }

    return Math.max(
      0,
      Math.min(
        leftHighest - cLow(current),
        rightHighest - cLow(current)
      )
    );
  }

  return 0;
}

function isSignificantSwing(
  candles,
  index,
  left,
  right,
  type
) {
  const minSwingAtr = getConfigNumber(
    "MAJOR_SWING_MIN_ATR",
    1.5
  );

  const atr = calculateLocalATR(candles, index);

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

export function calculateEMA(candles, period) {
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

    closes.push(cClose(candle));
  }

  const multiplier = 2 / (period + 1);

  let ema =
    closes
      .slice(0, period)
      .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < closes.length; i++) {
    ema += (closes[i] - ema) * multiplier;
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

      if (cHigh(candles[j]) > high) {
        isHigh = false;
      }

      if (cLow(candles[j]) < low) {
        isLow = false;
      }

      if (!isHigh && !isLow) break;
    }

    if (!validWindow) continue;

    if (isHigh) {
      const prominence = getSwingProminence(
        candles,
        i,
        left,
        right,
        "high"
      );

      if (
        prominence > 0 &&
        isSignificantSwing(
          candles,
          i,
          left,
          right,
          "high"
        )
      ) {
        highs.push({
          index: i,
          confirmed_index: i + right,
          price: high,
          type: "high",
          prominence
        });
      }
    }

    if (isLow) {
      const prominence = getSwingProminence(
        candles,
        i,
        left,
        right,
        "low"
      );

      if (
        prominence > 0 &&
        isSignificantSwing(
          candles,
          i,
          left,
          right,
          "low"
        )
      ) {
        lows.push({
          index: i,
          confirmed_index: i + right,
          price: low,
          type: "low",
          prominence
        });
      }
    }
  }

  return { highs, lows };
}

function normalizeRawPivots(pivots) {
  if (!Array.isArray(pivots) || pivots.length === 0) {
    return [];
  }

  const sorted = [...pivots].sort((a, b) => {
    if (a.index !== b.index) return a.index - b.index;

    if (a.prominence !== b.prominence) {
      return b.prominence - a.prominence;
    }

    return a.type === "high" ? -1 : 1;
  });

  const unique = [];

  for (const pivot of sorted) {
    const previous = unique[unique.length - 1];

    if (previous && previous.index === pivot.index) {
      if (pivot.prominence > previous.prominence) {
        unique[unique.length - 1] = pivot;
      }

      continue;
    }

    unique.push(pivot);
  }

  const alternating = [];

  for (const pivot of unique) {
    const previous = alternating[alternating.length - 1];

    if (!previous) {
      alternating.push(pivot);
      continue;
    }

    if (previous.type !== pivot.type) {
      alternating.push(pivot);
      continue;
    }

    const moreExtreme =
      pivot.type === "high"
        ? pivot.price > previous.price
        : pivot.price < previous.price;

    if (moreExtreme) {
      alternating[alternating.length - 1] = pivot;
    }
  }

  return alternating;
}

function calculatePathEfficiency(
  candles,
  startIndex,
  endIndex,
  direction
) {
  if (
    !Array.isArray(candles) ||
    startIndex < 0 ||
    endIndex >= candles.length ||
    endIndex <= startIndex
  ) {
    return 0;
  }

  let pathLength = 0;

  for (let i = startIndex + 1; i <= endIndex; i++) {
    if (
      !isValidCandle(candles[i - 1]) ||
      !isValidCandle(candles[i])
    ) {
      return 0;
    }

    pathLength += Math.abs(
      cClose(candles[i]) - cClose(candles[i - 1])
    );
  }

  if (pathLength <= 0) return 0;

  const startPrice = cClose(candles[startIndex]);
  const endPrice = cClose(candles[endIndex]);

  const netMovement =
    direction === "bullish"
      ? endPrice - startPrice
      : startPrice - endPrice;

  if (netMovement <= 0) return 0;

  return Math.min(1, netMovement / pathLength);
}

function findRoundedZone(
  candles,
  startIndex,
  endIndex,
  type,
  atr
) {
  if (
    !Array.isArray(candles) ||
    startIndex < 0 ||
    endIndex >= candles.length ||
    endIndex < startIndex ||
    !Number.isFinite(atr) ||
    atr <= 0
  ) {
    return null;
  }

  const tolerance = atr * getConfigNumber(
    "MAJOR_SWING_ROUNDED_ZONE_ATR",
    0.25
  );

  const minZoneBars = Math.floor(
    getConfigNumber(
      "MAJOR_SWING_MIN_ZONE_BARS",
      2,
      1
    )
  );

  let extremePrice =
    type === "high" ? -Infinity : Infinity;

  let extremeIndex = -1;

  for (let i = startIndex; i <= endIndex; i++) {
    if (!isValidCandle(candles[i])) return null;

    const price =
      type === "high"
        ? cHigh(candles[i])
        : cLow(candles[i]);

    const isMoreExtreme =
      type === "high"
        ? price > extremePrice
        : price < extremePrice;

    if (isMoreExtreme) {
      extremePrice = price;
      extremeIndex = i;
    }
  }

  if (extremeIndex < 0) return null;

  let zoneBars = 0;
  let zoneStart = -1;
  let zoneEnd = -1;

  for (let i = startIndex; i <= endIndex; i++) {
    const price =
      type === "high"
        ? cHigh(candles[i])
        : cLow(candles[i]);

    const isInsideZone =
      type === "high"
        ? price >= extremePrice - tolerance
        : price <= extremePrice + tolerance;

    if (!isInsideZone) continue;

    zoneBars++;

    if (zoneStart < 0) zoneStart = i;

    zoneEnd = i;
  }

  if (zoneBars < minZoneBars) return null;

  return {
    index: extremeIndex,
    price: extremePrice,
    start_index: zoneStart,
    end_index: zoneEnd,
    bars: zoneBars
  };
}

function validateMajorSwingFormation(
  candles,
  previous,
  candidate,
  next
) {
  if (!previous || !candidate || !next) return null;

  if (
    previous.type === candidate.type ||
    candidate.type === next.type ||
    previous.type !== next.type
  ) {
    return null;
  }

  if (
    previous.index >= candidate.index ||
    candidate.index >= next.index
  ) {
    return null;
  }

  const minFormationBars = Math.floor(
    getConfigNumber("MAJOR_SWING_MIN_BARS", 7, 3)
  );

  const totalBars = next.index - previous.index + 1;

  if (totalBars < minFormationBars) return null;

  const atr = calculateLocalATR(
    candles,
    candidate.index
  );

  if (!atr) return null;

  const type = candidate.type;

  const zone = findRoundedZone(
    candles,
    previous.index,
    next.index,
    type,
    atr
  );

  if (!zone) return null;

  const approachMovement =
    type === "high"
      ? zone.price - previous.price
      : previous.price - zone.price;

  const reversalMovement =
    type === "high"
      ? zone.price - next.price
      : next.price - zone.price;

  const minApproachAtr = getConfigNumber(
    "MAJOR_SWING_MIN_APPROACH_ATR",
    1.5
  );

  const minReversalAtr = getConfigNumber(
    "MAJOR_SWING_MIN_REVERSAL_ATR",
    1.5
  );

  if (approachMovement < atr * minApproachAtr) {
    return null;
  }

  if (reversalMovement < atr * minReversalAtr) {
    return null;
  }

  const approachEfficiency = calculatePathEfficiency(
    candles,
    previous.index,
    zone.index,
    type === "high" ? "bullish" : "bearish"
  );

  const reversalEfficiency = calculatePathEfficiency(
    candles,
    zone.index,
    next.index,
    type === "high" ? "bearish" : "bullish"
  );

  const minEfficiency = getConfigNumber(
    "MAJOR_SWING_MIN_EFFICIENCY",
    0.45
  );

  if (
    approachEfficiency < minEfficiency ||
    reversalEfficiency < minEfficiency
  ) {
    return null;
  }

  return {
    index: zone.index,
    price: zone.price,
    type,
    confirmed_index: candidate.confirmed_index,
    prominence: candidate.prominence,
    formation_start_index: previous.index,
    formation_end_index: next.index,
    formation_bars: totalBars,
    zone_start_index: zone.start_index,
    zone_end_index: zone.end_index,
    zone_bars: zone.bars,
    approach_atr: Number(
      (approachMovement / atr).toFixed(2)
    ),
    reversal_atr: Number(
      (reversalMovement / atr).toFixed(2)
    ),
    approach_efficiency: Number(
      approachEfficiency.toFixed(2)
    ),
    reversal_efficiency: Number(
      reversalEfficiency.toFixed(2)
    ),
    reversal_confirmed_index: next.confirmed_index
  };
}

function findStructureBreak(
  candles,
  candidate,
  reference,
  direction
) {
  if (!candidate || !reference) return null;

  const startIndex =
    candidate.reversal_confirmed_index + 1;

  const breakBufferAtr = getConfigNumber(
    "STRUCTURE_BREAK_BUFFER_ATR",
    0
  );

  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];

    if (!isValidCandle(candle)) continue;

    const atr = calculateLocalATR(candles, i);

    if (!atr) continue;

    const buffer = atr * breakBufferAtr;
    const close = cClose(candle);

    const broken =
      direction === "bearish"
        ? close < reference.price - buffer
        : close > reference.price + buffer;

    if (!broken) continue;

    return {
      index: i,
      candle,
      level: reference.price
    };
  }

  return null;
}

function calculateDisplacementScore(
  candles,
  breakIndex,
  direction
) {
  const candle = candles[breakIndex];

  if (!isValidCandle(candle)) {
    return {
      displacement: false,
      displacement_atr: 0,
      score: 70
    };
  }

  const atr = calculateLocalATR(candles, breakIndex);

  if (!atr) {
    return {
      displacement: false,
      displacement_atr: 0,
      score: 70
    };
  }

  const bodyAtr = cBody(candle) / atr;
  const range = cRange(candle);

  const closePosition =
    range > 0
      ? direction === "bearish"
        ? (cHigh(candle) - cClose(candle)) / range
        : (cClose(candle) - cLow(candle)) / range
      : 0;

  const minBodyAtr = getConfigNumber(
    "DISPLACEMENT_MIN_BODY_ATR",
    0.8
  );

  const minClosePosition = getConfigNumber(
    "DISPLACEMENT_CLOSE_POSITION",
    0.65,
    0.5
  );

  const hasCorrectDirection =
    direction === "bearish"
      ? isBear(candle)
      : isBull(candle);

  const hasDisplacement =
    hasCorrectDirection &&
    bodyAtr >= minBodyAtr &&
    closePosition >= minClosePosition;

  const bodyScore = Math.min(
    bodyAtr / Math.max(minBodyAtr, 0.01),
    1
  );

  const closeScore = Math.min(
    closePosition / Math.max(minClosePosition, 0.01),
    1
  );

  const score = Math.round(
    70 + bodyScore * 15 + closeScore * 15
  );

  return {
    displacement: hasDisplacement,
    displacement_atr: Number(bodyAtr.toFixed(2)),
    score: Math.min(100, score)
  };
}

function confirmMajorSwings(candles, pivots) {
  const confirmedHighs = [];
  const confirmedLows = [];

  if (!Array.isArray(pivots) || pivots.length < 3) {
    return {
      highs: confirmedHighs,
      lows: confirmedLows
    };
  }

  for (let i = 1; i < pivots.length - 1; i++) {
    const previous = pivots[i - 1];
    const candidate = pivots[i];
    const next = pivots[i + 1];

    const formation = validateMajorSwingFormation(
      candles,
      previous,
      candidate,
      next
    );

    if (!formation) continue;

    const direction =
      candidate.type === "high"
        ? "bearish"
        : "bullish";

    const structureBreak = findStructureBreak(
      candles,
      formation,
      previous,
      direction
    );

    if (!structureBreak) continue;

    const quality = calculateDisplacementScore(
      candles,
      structureBreak.index,
      direction
    );

    const swing = {
      ...formation,
      confirmed_index: structureBreak.index,
      pivot_confirmed_index: candidate.confirmed_index,
      break_index: structureBreak.index,
      break_level: structureBreak.level,
      reference_index: previous.index,
      displacement: quality.displacement,
      displacement_atr: quality.displacement_atr,
      score: quality.score
    };

    if (candidate.type === "high") {
      confirmedHighs.push(swing);
    } else {
      confirmedLows.push(swing);
    }
  }

  return {
    highs: confirmedHighs,
    lows: confirmedLows
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
    candles.length < left + right + 15
  ) {
    return { highs: [], lows: [] };
  }

  const raw = detectRawPivots(
    candles,
    left,
    right
  );

  const combined = [
    ...raw.highs,
    ...raw.lows
  ];

  const alternating = normalizeRawPivots(combined);

  return confirmMajorSwings(
    candles,
    alternating
  );
}

export function getLatestMinorSwings(
  swings,
  count = 2
) {
  if (
    !swings ||
    !Number.isInteger(count) ||
    count < 1
  ) {
    return { highs: [], lows: [] };
  }

  const minDistance = getConfigNumber(
    "MIN_SWING_DISTANCE",
    10,
    1
  );

  const maxDistance = getConfigNumber(
    "MAX_SWING_DISTANCE",
    50,
    1
  );

  const getValidSwings = (items, type) => {
    const valid = (
      Array.isArray(items) ? items : []
    )
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
      const swing = valid[i];

      if (result.length === 0) {
        result.unshift(swing);
        continue;
      }

      const lastSelected = result[0];
      const distance = lastSelected.index - swing.index;

      if (
        distance >= minDistance &&
        distance <= maxDistance
      ) {
        result.unshift(swing);
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

export function isValidStructure(
  swingA,
  swingB,
  direction
) {
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

  const minDistance = getConfigNumber(
    "MIN_SWING_DISTANCE",
    10,
    1
  );

  const maxDistance = getConfigNumber(
    "MAX_SWING_DISTANCE",
    50,
    1
  );

  const distance = swingB.index - swingA.index;

  if (distance < minDistance || distance > maxDistance) {
    return false;
  }

  if (
    swingB.confirmed_index <= swingA.confirmed_index
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

export function calculateTrendline(
  swingA,
  swingB
) {
  if (
    !swingA ||
    !swingB ||
    swingB.index === swingA.index
  ) {
    return null;
  }

  const slope =
    (swingB.price - swingA.price) /
    (swingB.index - swingA.index);

  const intercept =
    swingA.price - slope * swingA.index;

  if (
    !Number.isFinite(slope) ||
    !Number.isFinite(intercept)
  ) {
    return null;
  }

  return { slope, intercept };
}

export function getTrendlinePrice(
  trendline,
  index
) {
  if (
    !trendline ||
    !Number.isFinite(index)
  ) {
    return null;
  }

  const price =
    trendline.slope * index +
    trendline.intercept;

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
    !trendline ||
    !Number.isInteger(startIndex)
  ) {
    return null;
  }

  const firstIndex = Math.max(1, startIndex);

  const minBodyRatio = getConfigNumber(
    "BREAKOUT_MIN_BODY_RATIO",
    0.5
  );

  for (let i = firstIndex; i < candles.length; i++) {
    const previous = candles[i - 1];
    const candle = candles[i];

    if (
      !isValidCandle(previous) ||
      !isValidCandle(candle)
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
      !Number.isFinite(previousLine) ||
      !Number.isFinite(currentLine)
    ) {
      continue;
    }

    let tradeDirection = null;

    if (lineDirection === "bearish") {
      if (
        cClose(previous) <= previousLine &&
        cClose(candle) > currentLine
      ) {
        tradeDirection = "bullish";
      }
    } else if (lineDirection === "bullish") {
      if (
        cClose(previous) >= previousLine &&
        cClose(candle) < currentLine
      ) {
        tradeDirection = "bearish";
      }
    }

    if (!tradeDirection) continue;

    const candleRange = cRange(candle);
    const candleBody = cBody(candle);

    if (
      candleRange > 0 &&
      candleBody / candleRange < minBodyRatio
    ) {
      continue;
    }

    const zoneHigh = cHigh(candle);
    const zoneLow = cLow(candle);
    const zoneWidth = zoneHigh - zoneLow;

    if (
      !Number.isFinite(zoneWidth) ||
      zoneWidth <= 0
    ) {
      continue;
    }

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

export function isPinBar(candle, direction) {
  if (!isValidCandle(candle)) return false;

  const range = cRange(candle);

  if (range <= 0) return false;

  const body = cBody(candle);

  const bodyRatio = getConfigNumber(
    "PINBAR_BODY_RATIO",
    0.3
  );

  if (body / range > bodyRatio) return false;

  const upperWick =
    cHigh(candle) -
    Math.max(cOpen(candle), cClose(candle));

  const lowerWick =
    Math.min(cOpen(candle), cClose(candle)) -
    cLow(candle);

  if (direction === "bearish") {
    return upperWick > body * 2;
  }

  if (direction === "bullish") {
    return lowerWick > body * 2;
  }

  return false;
}

export function isEngulfing(
  prevCandle,
  currCandle,
  direction
) {
  if (
    !isValidCandle(prevCandle) ||
    !isValidCandle(currCandle)
  ) {
    return false;
  }

  const currBody = cBody(currCandle);
  const currRange = cRange(currCandle);

  if (currRange <= 0) return false;

  const bodyRatio = getConfigNumber(
    "ENGULFING_BODY_RATIO",
    0.95
  );

  if (currBody / currRange < bodyRatio) {
    return false;
  }

  const prevTop = Math.max(
    cOpen(prevCandle),
    cClose(prevCandle)
  );

  const prevBottom = Math.min(
    cOpen(prevCandle),
    cClose(prevCandle)
  );

  const currTop = Math.max(
    cOpen(currCandle),
    cClose(currCandle)
  );

  const currBottom = Math.min(
    cOpen(currCandle),
    cClose(currCandle)
  );

  if (direction === "bearish") {
    return (
      isBear(prevCandle) &&
      isBear(currCandle) &&
      currTop >= prevTop &&
      currBottom <= prevBottom
    );
  }

  if (direction === "bullish") {
    return (
      isBull(prevCandle) &&
      isBull(currCandle) &&
      currTop >= prevTop &&
      currBottom <= prevBottom
    );
  }

  return false;
}
