import { CONFIG } from "./config.js";
import { getMarketSnapshot } from "./exchanges.js";
import {
  detectSwings,
  getLatestMinorSwings,
  isValidStructure,
  calculateTrendline,
  detectBreakout,
  detectFirstPullback,
  calculateATR
} from "./indicators.js";

function getPriceDecimals(price) {
  if (!Number.isFinite(price) || price <= 0) return 8;

  const str = price.toString();

  if (str.includes("e-")) {
    return parseInt(str.split("e-")[1], 10);
  }

  const parts = str.split(".");
  return parts.length > 1 ? parts[1].length : 0;
}

function isValidCandle(candle) {
  return (
    candle &&
    candle.incomplete !== true &&
    Number.isFinite(candle.time) &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close) &&
    candle.high >= candle.low &&
    candle.high >= Math.max(candle.open, candle.close) &&
    candle.low <= Math.min(candle.open, candle.close)
  );
}

function createResult(symbol, timeframe) {
  return {
    symbol,
    timeframe,
    status: "NO_TRADE",
    direction: null,
    current_price: null,
    entry: null,
    stop_loss: null,
    take_profit: null,
    zone_low: null,
    zone_high: null,
    zone_width: null,
    rr: 0,
    signal_candle_time: null,
    highs: null,
    lows: null,
    reasons: []
  };
}

function selectStructure(latest, result) {
  const bearishStructure = isValidStructure(
    latest.highs[0],
    latest.highs[1],
    "bearish"
  );

  const bullishStructure = isValidStructure(
    latest.lows[0],
    latest.lows[1],
    "bullish"
  );

  if (!bearishStructure && !bullishStructure) {
    return null;
  }

  if (
    bearishStructure &&
    bullishStructure &&
    latest.highs[1].confirmed_index >= latest.lows[1].confirmed_index
  ) {
    result.highs = [
      latest.highs[0].price,
      latest.highs[1].price
    ];

    return {
      direction: "bearish",
      swingA: latest.highs[0],
      swingB: latest.highs[1],
      confirmedIndex: latest.highs[1].confirmed_index
    };
  }

  if (bullishStructure) {
    result.lows = [
      latest.lows[0].price,
      latest.lows[1].price
    ];

    return {
      direction: "bullish",
      swingA: latest.lows[0],
      swingB: latest.lows[1],
      confirmedIndex: latest.lows[1].confirmed_index
    };
  }

  result.highs = [
    latest.highs[0].price,
    latest.highs[1].price
  ];

  return {
    direction: "bearish",
    swingA: latest.highs[0],
    swingB: latest.highs[1],
    confirmedIndex: latest.highs[1].confirmed_index
  };
}

function calculateStopLoss(zoneLow, zoneHigh, direction, candles) {
  const atr = calculateATR(candles, 14);
  const multiplier = CONFIG.STOP_ATR_MULTIPLIER;

  const stopBuffer =
    Number.isFinite(atr) &&
    atr > 0 &&
    Number.isFinite(multiplier) &&
    multiplier >= 0
      ? atr * multiplier
      : 0;

  return direction === "bullish"
    ? zoneLow - stopBuffer
    : zoneHigh + stopBuffer;
}

function calculateTradeLevels(breakout, direction, candles) {
  const zoneLow = breakout.zoneLow;
  const zoneHigh = breakout.zoneHigh;
  const zoneWidth = zoneHigh - zoneLow;

  if (
    !Number.isFinite(zoneLow) ||
    !Number.isFinite(zoneHigh) ||
    !Number.isFinite(zoneWidth) ||
    zoneWidth <= 0
  ) {
    return null;
  }

  const isBullish = direction === "bullish";
  const entry = (zoneHigh + zoneLow) / 2;

  const stopLoss = calculateStopLoss(
    zoneLow,
    zoneHigh,
    direction,
    candles
  );

  const multiplier = CONFIG.TARGET_ZONE_MULTIPLIER;

  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    return null;
  }

  const targetDistance = zoneWidth * multiplier;

  const takeProfit = isBullish
    ? zoneHigh + targetDistance
    : zoneLow - targetDistance;

  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);

  const rr =
    Number.isFinite(risk) &&
    risk > 0 &&
    Number.isFinite(reward) &&
    reward > 0
      ? reward / risk
      : 0;

  if (!Number.isFinite(takeProfit)) {
    return null;
  }

  return {
    zoneLow,
    zoneHigh,
    zoneWidth,
    entry,
    stopLoss,
    takeProfit,
    rr
  };
}

export async function analyze(symbol, timeframe = CONFIG.TIMEFRAME) {
  const result = createResult(symbol, timeframe);

  try {
    const snapshot = await getMarketSnapshot(symbol, timeframe);

    const candles = Array.isArray(snapshot?.current)
      ? snapshot.current.filter(isValidCandle)
      : [];

    if (
      !Number.isInteger(CONFIG.MIN_CANDLES) ||
      CONFIG.MIN_CANDLES < 1 ||
      candles.length < CONFIG.MIN_CANDLES
    ) {
      result.reasons.push("تعداد کندل بسته‌شده کافی نیست");
      return result;
    }

    const lastCandle = candles[candles.length - 1];

    result.current_price = lastCandle.close;

    const swings = detectSwings(candles);
    const latest = getLatestMinorSwings(swings, 2);

    if (
      latest.highs.length < 2 ||
      latest.lows.length < 2
    ) {
      result.reasons.push("سقف و کف مینور کافی یافت نشد");
      return result;
    }

    const structure = selectStructure(latest, result);

    if (!structure || !Number.isInteger(structure.confirmedIndex)) {
      result.reasons.push(
        "ساختار معتبر Lower High یا Higher Low یافت نشد"
      );
      return result;
    }

    const trendline = calculateTrendline(
      structure.swingA,
      structure.swingB
    );

    if (!trendline) {
      result.reasons.push("محاسبه خط روند معتبر نیست");
      return result;
    }

    const breakout = detectBreakout(
      candles,
      trendline,
      structure.direction,
      structure.confirmedIndex + 1
    );

    if (!breakout) {
      result.reasons.push("شکست معتبر خط روند رخ نداده است");
      return result;
    }

    const maxPullbackBars = CONFIG.PULLBACK_MAX_BARS;

    if (
      !Number.isInteger(maxPullbackBars) ||
      maxPullbackBars < 1
    ) {
      result.reasons.push("تنظیمات محدوده تأیید پولبک معتبر نیست");
      return result;
    }

    const tradeDirection = breakout.direction;

    const pullback = detectFirstPullback(
      candles,
      tradeDirection,
      breakout.index,
      maxPullbackBars,
      breakout.zoneLow,
      breakout.zoneHigh
    );

    if (!pullback) {
      result.reasons.push(
        "اولین پولبک در محدوده شکست یافت نشد"
      );
      return result;
    }

    const levels = calculateTradeLevels(
      breakout,
      tradeDirection,
      candles
    );

    if (!levels) {
      result.reasons.push(
        "محاسبه محدوده ورود یا تارگت معتبر نیست"
      );
      return result;
    }

    result.direction = tradeDirection;
    result.zone_low = levels.zoneLow;
    result.zone_high = levels.zoneHigh;
    result.zone_width = levels.zoneWidth;
    result.entry = levels.entry;
    result.stop_loss = levels.stopLoss;
    result.take_profit = levels.takeProfit;
    result.rr = levels.rr;
    result.signal_candle_time = pullback.candle.time;
    result.status = tradeDirection === "bullish" ? "LONG" : "SHORT";

    return result;
  } catch (e) {
    result.reasons.push(
      "خطا در تحلیل: " + ((e && e.message) || "unknown")
    );

    return result;
  }
}
