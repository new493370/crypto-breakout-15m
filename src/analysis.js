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

export async function analyze(symbol) {
  const result = {
    symbol,
    timeframe: CONFIG.TIMEFRAME,
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
    reasons: []
  };

  try {
    const snapshot = await getMarketSnapshot(symbol, CONFIG.TIMEFRAME);
    const candles = snapshot && Array.isArray(snapshot.current) ? snapshot.current : [];

    if (candles.length < CONFIG.MIN_CANDLES) {
      result.reasons.push("تعداد کندل کافی نیست");
      return result;
    }

    const lastCandle = candles[candles.length - 1];
    if (!lastCandle || !Number.isFinite(lastCandle.close)) {
      result.reasons.push("قیمت فعلی معتبر نیست");
      return result;
    }

    result.current_price = lastCandle.close;

    const swings = detectSwings(candles);

    const latest = getLatestMinorSwings(swings, 2);

    if (!latest.highs || latest.highs.length < 2 || !latest.lows || latest.lows.length < 2) {
      result.reasons.push("سقف و کف مینور کافی یافت نشد");
      return result;
    }

    const highA = latest.highs[0];
    const highB = latest.highs[1];
    const lowA = latest.lows[0];
    const lowB = latest.lows[1];

    const isBullStructure = isValidStructure(lowA, lowB, "bullish");
    const isBearStructure = isValidStructure(highA, highB, "bearish");

    let trendline = null;
    let direction = null;
    let structureIndex = 0;

    if (isBearStructure) {
      trendline = calculateTrendline(highA, highB);
      direction = "bearish";
      structureIndex = highB.index;
    } else if (isBullStructure) {
      trendline = calculateTrendline(lowA, lowB);
      direction = "bullish";
      structureIndex = lowB.index;
    }

    if (!trendline || !direction) {
      result.reasons.push("ساختار قیمتی معتبری برای رسم خط روند یافت نشد");
      return result;
    }

    const breakout = detectBreakout(candles, trendline, direction, structureIndex + 1);

    if (!breakout) {
      result.reasons.push("شکست معتبر خط روند رخ نداده است");
      return result;
    }

    result.zone_low = breakout.zoneLow;
    result.zone_high = breakout.zoneHigh;
    result.zone_width = breakout.zoneWidth;
    result.direction = direction;

    const maxWaitBars = CONFIG.BREAKOUT_CONFIRMATION_BARS;
    const engulf = detectEngulfing(
      candles,
      direction,
      breakout.index,
      maxWaitBars,
      breakout.zoneLow,
      breakout.zoneHigh
    );

    if (!engulf) {
      result.reasons.push("کندل اینگولف در محدوده شکست یافت نشد");
      return result;
    }

    const entry = engulf.entryPrice;

    let stopLoss;

    if (direction === "bullish") {
      stopLoss = breakout.zoneLow - (breakout.zoneWidth * CONFIG.STOP_BUFFER_MULTIPLIER);
    } else {
      stopLoss = breakout.zoneHigh + (breakout.zoneWidth * CONFIG.STOP_BUFFER_MULTIPLIER);
    }

    const risk = Math.abs(entry - stopLoss);
    if (!Number.isFinite(risk) || risk <= 0) {
      result.reasons.push("فاصله ریسک معتبر نیست");
      return result;
    }

    let takeProfit;
    if (direction === "bullish") {
      takeProfit = entry + risk * CONFIG.RISK_REWARD_RATIO;
    } else {
      takeProfit = entry - risk * CONFIG.RISK_REWARD_RATIO;
    }

    const currentPrice = result.current_price;
    const priceInZone = currentPrice >= breakout.zoneLow && currentPrice <= breakout.zoneHigh;

    result.entry = entry;
    result.stop_loss = stopLoss;
    result.take_profit = takeProfit;
    result.rr = CONFIG.RISK_REWARD_RATIO;

    if (priceInZone) {
      result.status = direction === "bullish" ? "LONG" : "SHORT";
      result.reasons.push("قیمت هم اکنون داخل محدوده ورود قرار دارد");
    } else if (
      (direction === "bullish" && currentPrice <= entry * 1.02) ||
      (direction === "bearish" && currentPrice >= entry * 0.98)
    ) {
      result.status = "WAIT";
      result.reasons.push("قیمت نزدیک محدوده ورود است");
    } else {
      result.status = "NO_TRADE";
      result.reasons.push("قیمت از محدوده ورود فاصله دارد");
    }

    return result;

  } catch (e) {
    result.reasons.push("خطا در تحلیل: " + ((e && e.message) || "unknown"));
    return result;
  }
}
