import { CONFIG } from "./config.js";
import { getMarketSnapshot } from "./exchanges.js";
import {
  detectSwings,
  getLatestMinorSwings,
  isValidStructure,
  calculateTrendline,
  detectBreakout,
  calculateEMA,
  isPinBar,
  isEngulfing
} from "./indicators.js";

function isValidCandle(candle) {
  if (!candle || candle.incomplete) return false;

  return (
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close) &&
    candle.high >= candle.low &&
    candle.high >= Math.max(candle.open, candle.close) &&
    candle.low <= Math.min(candle.open, candle.close)
  );
}

function isStrongMomentum(candles, direction) {
  if (
    !Array.isArray(candles) ||
    candles.length < CONFIG.MOMENTUM_CANDLE_COUNT
  ) {
    return false;
  }

  const recent = candles.slice(-CONFIG.MOMENTUM_CANDLE_COUNT);

  const strongBullish = recent.every(
    c => c.close > c.open && c.close - c.open > (c.high - c.low) * 0.5
  );

  const strongBearish = recent.every(
    c => c.close < c.open && c.open - c.close > (c.high - c.low) * 0.5
  );

  if (direction === "bullish" && strongBearish) return true;
  if (direction === "bearish" && strongBullish) return true;

  return false;
}

function detectValidRetestEntry(
  candles,
  direction,
  breakoutIndex,
  maxBars,
  zoneLow,
  zoneHigh
) {
  if (
    !Array.isArray(candles) ||
    !["bullish", "bearish"].includes(direction) ||
    !Number.isInteger(breakoutIndex) ||
    breakoutIndex < 0 ||
    !Number.isInteger(maxBars) ||
    maxBars < 1 ||
    !Number.isFinite(zoneLow) ||
    !Number.isFinite(zoneHigh) ||
    zoneLow >= zoneHigh ||
    breakoutIndex >= candles.length - 1
  ) {
    return null;
  }

  const endIndex = Math.min(
    candles.length - 1,
    breakoutIndex + maxBars
  );

  const requiredAwayBars = Number.isFinite(CONFIG.REQUIRED_AWAY_BARS)
    ? Math.max(1, Math.trunc(CONFIG.REQUIRED_AWAY_BARS))
    : 1;

  let consecutiveAway = 0;
  let hasMovedAway = false;

  for (let i = breakoutIndex + 1; i <= endIndex; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    if (!isValidCandle(current) || !isValidCandle(previous)) {
      continue;
    }

    const isOutsideZone = direction === "bullish"
      ? current.close > zoneHigh
      : current.close < zoneLow;

    if (!hasMovedAway) {
      if (isOutsideZone) {
        consecutiveAway++;
        if (consecutiveAway >= requiredAwayBars) {
          hasMovedAway = true;
        }
      } else {
        consecutiveAway = 0;
      }
      continue;
    }

    const touchesZone =
      current.low <= zoneHigh &&
      current.high >= zoneLow;

    if (!touchesZone) {
      continue;
    }

    const entryPrice = (zoneHigh + zoneLow) / 2;

    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      continue;
    }

    const pinBarValid = isPinBar(current, direction);
    const engulfingValid = isEngulfing(previous, current, direction);

    if (!pinBarValid && !engulfingValid) {
      continue;
    }

    return {
      index: i,
      candle: current,
      entryPrice
    };
  }

  return null;
}

export async function analyze(symbol, timeframe = CONFIG.TIMEFRAME) {
  const result = {
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
    breakout_candle_time: null,
    retest_candle_time: null,
    engulfing_candle_time: null,
    swing_high_a: null,
    swing_high_b: null,
    swing_low_a: null,
    swing_low_b: null,
    reasons: []
  };

  try {
    const snapshot = await getMarketSnapshot(symbol, timeframe);

    const candles = Array.isArray(snapshot?.current)
      ? snapshot.current.filter(isValidCandle)
      : [];

    if (candles.length < CONFIG.MIN_CANDLES) {
      result.reasons.push("تعداد کندل بسته‌شده کافی نیست");
      return result;
    }

    const lastCandle = candles[candles.length - 1];
    result.current_price = lastCandle.close;

    const emaPeriod = Number.isFinite(CONFIG.EMA_PERIOD)
      ? CONFIG.EMA_PERIOD
      : 50;

    const ema50 = calculateEMA(candles, emaPeriod);
    const isUptrend = ema50 !== null && lastCandle.close > ema50;
    const isDowntrend = ema50 !== null && lastCandle.close < ema50;

    const swings = detectSwings(candles);
    const latest = getLatestMinorSwings(swings, 2);

    if (latest.highs.length < 2 || latest.lows.length < 2) {
      result.reasons.push("سقف و کف مینور کافی یافت نشد");
      return result;
    }

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

    let lineDirection = null;
    let trendline = null;
    let structureConfirmedIndex = -1;

    if (bearishStructure && bullishStructure) {
      if (
        latest.highs[1].confirmed_index >=
        latest.lows[1].confirmed_index
      ) {
        lineDirection = "bearish";
        trendline = calculateTrendline(
          latest.highs[0],
          latest.highs[1]
        );
        structureConfirmedIndex = latest.highs[1].confirmed_index;
      } else {
        lineDirection = "bullish";
        trendline = calculateTrendline(
          latest.lows[0],
          latest.lows[1]
        );
        structureConfirmedIndex = latest.lows[1].confirmed_index;
      }
    } else if (bearishStructure) {
      lineDirection = "bearish";
      trendline = calculateTrendline(
        latest.highs[0],
        latest.highs[1]
      );
      structureConfirmedIndex = latest.highs[1].confirmed_index;
    } else if (bullishStructure) {
      lineDirection = "bullish";
      trendline = calculateTrendline(
        latest.lows[0],
        latest.lows[1]
      );
      structureConfirmedIndex = latest.lows[1].confirmed_index;
    }

    if (!trendline || structureConfirmedIndex < 0) {
      result.reasons.push(
        "ساختار معتبر Lower High یا Higher Low یافت نشد"
      );
      return result;
    }

    result.swing_high_a = latest.highs[0] || null;
    result.swing_high_b = latest.highs[1] || null;
    result.swing_low_a = latest.lows[0] || null;
    result.swing_low_b = latest.lows[1] || null;

    const breakout = detectBreakout(
      candles,
      trendline,
      lineDirection,
      structureConfirmedIndex + 1
    );

    if (!breakout) {
      result.reasons.push("شکست معتبر خط روند رخ نداده است");
      return result;
    }

    const tradeDirection = breakout.direction;

    result.direction = tradeDirection;
    result.zone_low = breakout.zoneLow;
    result.zone_high = breakout.zoneHigh;
    result.zone_width = breakout.zoneWidth;
    result.breakout_candle_time = breakout.candle.time;

    if (tradeDirection === "bearish" && isUptrend) {
      result.reasons.push(
        "مخالفت با روند اصلی (EMA50 صعودی) - شورت مجاز نیست"
      );
      return result;
    }

    if (tradeDirection === "bullish" && isDowntrend) {
      result.reasons.push(
        "مخالفت با روند اصلی (EMA50 نزولی) - لانگ مجاز نیست"
      );
      return result;
    }

    const minZoneWidthRatio = Number.isFinite(CONFIG.MIN_ZONE_WIDTH_RATIO)
      ? Math.max(0, CONFIG.MIN_ZONE_WIDTH_RATIO)
      : 0.001;

    const minZoneWidth = result.zone_low * minZoneWidthRatio;

    if (result.zone_width < minZoneWidth) {
      result.reasons.push("عرض محدوده شکست خیلی کوچیکه");
      return result;
    }

    const setup = detectValidRetestEntry(
      candles,
      tradeDirection,
      breakout.index,
      CONFIG.BREAKOUT_CONFIRMATION_BARS,
      breakout.zoneLow,
      breakout.zoneHigh
    );

    if (!setup) {
      result.reasons.push(
        "شکست ثبت شد؛ قیمت هنوز فاصله‌گیری و بازگشت معتبر به محدوده شکست را تکمیل نکرده است"
      );
      return result;
    }

    if (
      isStrongMomentum(
        candles.slice(0, setup.index + 1),
        tradeDirection
      )
    ) {
      result.reasons.push(
        "مومنتوم شدید خلاف جهت ستاپ - سیگنال رد شد"
      );
      return result;
    }

    const isBullish = tradeDirection === "bullish";
    const entry = setup.entryPrice;
    const zoneLow = breakout.zoneLow;
    const zoneHigh = breakout.zoneHigh;
    const zoneWidth = breakout.zoneWidth;

    if (
      !Number.isFinite(entry) ||
      !Number.isFinite(zoneLow) ||
      !Number.isFinite(zoneHigh) ||
      !Number.isFinite(zoneWidth) ||
      zoneWidth <= 0
    ) {
      result.reasons.push("قیمت ورود یا محدوده شکست معتبر نیست");
      return result;
    }

    const buffer = zoneWidth * CONFIG.STOP_BUFFER_MULTIPLIER;

    const stopLoss = isBullish
      ? zoneLow - buffer
      : zoneHigh + buffer;

    const risk = Math.abs(entry - stopLoss);

    if (!Number.isFinite(risk) || risk <= 0) {
      result.reasons.push("محاسبه ریسک معتبر نیست");
      return result;
    }

    const takeProfit = isBullish
      ? entry + CONFIG.RISK_REWARD_RATIO * risk
      : entry - CONFIG.RISK_REWARD_RATIO * risk;

    const reward = Math.abs(takeProfit - entry);

    if (!Number.isFinite(reward) || reward <= 0) {
      result.reasons.push("محاسبه تارگت معتبر نیست");
      return result;
    }

    result.direction = tradeDirection;
    result.entry = entry;
    result.stop_loss = stopLoss;
    result.take_profit = takeProfit;
    result.rr = reward / risk;
    result.signal_candle_time = setup.candle.time;
    result.retest_candle_time = setup.candle.time;
    result.status = isBullish ? "LONG" : "SHORT";

    result.reasons.push(
      "شکست خط روند، فاصله‌گیری قیمت و بازگشت معتبر با تأیید پین‌بار/اینگولف تأیید شد"
    );

    return result;
  } catch (e) {
    result.reasons.push(
      "خطا در تحلیل: " + ((e && e.message) || "unknown")
    );
    return result;
  }
}
