import { CONFIG } from "./config.js";
import { getMarketSnapshot } from "./exchanges.js";
import {
  detectSwings,
  getLatestMinorSwings,
  isValidStructure,
  calculateTrendline,
  detectBreakout,
  detectEngulfing
} from "./indicators.js";

function isStrongMomentum(candles, direction) {
  if (!Array.isArray(candles) || candles.length < CONFIG.MOMENTUM_CANDLE_COUNT) return false;

  const recent = candles.slice(-CONFIG.MOMENTUM_CANDLE_COUNT);

  const strongBullish = recent.every(c => c.close > c.open && (c.close - c.open) > (c.high - c.low) * 0.5);
  const strongBearish = recent.every(c => c.close < c.open && (c.open - c.close) > (c.high - c.low) * 0.5);

  if (direction === "bullish" && strongBearish) return true;
  if (direction === "bearish" && strongBullish) return true;

  return false;
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
    reasons: []
  };

  try {
    const snapshot = await getMarketSnapshot(symbol, timeframe);
    const candles = Array.isArray(snapshot?.current)
      ? snapshot.current.filter(c =>
          c &&
          c.incomplete !== true &&
          Number.isFinite(c.time) &&
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close)
        )
      : [];

    if (candles.length < CONFIG.MIN_CANDLES) {
      result.reasons.push("تعداد کندل بسته‌شده کافی نیست");
      return result;
    }

    const lastCandle = candles[candles.length - 1];
    result.current_price = lastCandle.close;

    const swings = detectSwings(candles);
    const latest = getLatestMinorSwings(swings, 2);

    if (latest.highs.length < 2 || latest.lows.length < 2) {
      result.reasons.push("سقف و کف مینور کافی یافت نشد");
      return result;
    }

    const highA = latest.highs[0];
    const highB = latest.highs[1];
    const lowA = latest.lows[0];
    const lowB = latest.lows[1];

    const bearishStructure = isValidStructure(highA, highB, "bearish");
    const bullishStructure = isValidStructure(lowA, lowB, "bullish");

    let lineDirection = null;
    let trendline = null;
    let structureConfirmedIndex = -1;

    if (bearishStructure && bullishStructure) {
      if (highB.confirmed_index >= lowB.confirmed_index) {
        lineDirection = "bearish";
        trendline = calculateTrendline(highA, highB);
        structureConfirmedIndex = highB.confirmed_index;
      } else {
        lineDirection = "bullish";
        trendline = calculateTrendline(lowA, lowB);
        structureConfirmedIndex = lowB.confirmed_index;
      }
    } else if (bearishStructure) {
      lineDirection = "bearish";
      trendline = calculateTrendline(highA, highB);
      structureConfirmedIndex = highB.confirmed_index;
    } else if (bullishStructure) {
      lineDirection = "bullish";
      trendline = calculateTrendline(lowA, lowB);
      structureConfirmedIndex = lowB.confirmed_index;
    }

    if (!trendline || structureConfirmedIndex < 0) {
      result.reasons.push("ساختار معتبر Lower High یا Higher Low یافت نشد");
      return result;
    }

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

    if (isStrongMomentum(candles, breakout.direction)) {
      result.reasons.push("مومنتوم شدید خلاف جهت ستاپ - سیگنال رد شد");
      return result;
    }

    const engulf = detectEngulfing(
      candles,
      breakout.direction,
      breakout.index,
      CONFIG.BREAKOUT_CONFIRMATION_BARS,
      breakout.zoneLow,
      breakout.zoneHigh
    );

    if (!engulf) {
      result.reasons.push("Engulfing معتبر در محدوده شکست یافت نشد");
      return result;
    }

    const zoneLow = breakout.zoneLow;
    const zoneHigh = breakout.zoneHigh;
    const zoneWidth = zoneHigh - zoneLow;
    const entry = (zoneHigh + zoneLow) / 2;

    if (!Number.isFinite(zoneWidth) || zoneWidth <= 0) {
      result.reasons.push("عرض محدوده شکست معتبر نیست");
      return result;
    }

    const isBullish = breakout.direction === "bullish";

    let structuralStop;
    if (isBullish) {
      const recentLow = latest.lows[0];
      structuralStop = recentLow.price - (zoneWidth * CONFIG.STOP_BUFFER_MULTIPLIER);
    } else {
      const recentHigh = latest.highs[0];
      structuralStop = recentHigh.price + (zoneWidth * CONFIG.STOP_BUFFER_MULTIPLIER);
    }

    let stopLoss = structuralStop;

    if (isBullish && stopLoss >= entry) {
      stopLoss = zoneLow - (zoneWidth * CONFIG.STOP_BUFFER_MULTIPLIER);
    }
    if (!isBullish && stopLoss <= entry) {
      stopLoss = zoneHigh + (zoneWidth * CONFIG.STOP_BUFFER_MULTIPLIER);
    }

    const risk = Math.abs(entry - stopLoss);

    if (!Number.isFinite(risk) || risk <= 0) {
      result.reasons.push("محاسبه ریسک معتبر نیست");
      return result;
    }

    const takeProfit = isBullish
      ? entry + (CONFIG.RISK_REWARD_RATIO * risk)
      : entry - (CONFIG.RISK_REWARD_RATIO * risk);

    const reward = Math.abs(takeProfit - entry);

    if (!Number.isFinite(reward) || reward <= 0) {
      result.reasons.push("محاسبه تارگت معتبر نیست");
      return result;
    }

    result.direction = breakout.direction;
    result.zone_low = zoneLow;
    result.zone_high = zoneHigh;
    result.zone_width = zoneWidth;
    result.entry = entry;
    result.stop_loss = stopLoss;
    result.take_profit = takeProfit;
    result.rr = reward / risk;
    result.signal_candle_time = engulf.candle.time;
    result.status = isBullish ? "LONG" : "SHORT";
    result.reasons.push("شکست خط روند و اولین Engulfing معتبر در محدوده شکست تأیید شد");

    return result;
  } catch (e) {
    result.reasons.push("خطا در تحلیل: " + ((e && e.message) || "unknown"));
    return result;
  }
}
