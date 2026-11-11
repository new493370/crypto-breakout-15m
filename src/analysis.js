import { CONFIG } from "./config.js";
import { getMarketSnapshot } from "./exchanges.js";
import {
  detectSwings,
  getLatestMinorSwings,
  isValidStructure,
  calculateTrendline,
  detectBreakout,
  detectFirstPullback
} from "./indicators.js";

function getPriceDecimals(price) {
  if (!Number.isFinite(price) || price <= 0) return 8;
  const str = price.toString();
  if (str.includes("e-")) {
    const parts = str.split("e-");
    return parseInt(parts[1], 10);
  }
  const parts = str.split(".");
  return parts.length > 1 ? parts[1].length : 0;
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
    highs: null,
    lows: null,
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

    const bearishStructure = isValidStructure(latest.highs[0], latest.highs[1], "bearish");
    const bullishStructure = isValidStructure(latest.lows[0], latest.lows[1], "bullish");

    let lineDirection = null;
    let trendline = null;
    let structureConfirmedIndex = -1;

    if (bearishStructure && bullishStructure) {
      if (latest.highs[1].confirmed_index >= latest.lows[1].confirmed_index) {
        lineDirection = "bearish";
        trendline = calculateTrendline(latest.highs[0], latest.highs[1]);
        structureConfirmedIndex = latest.highs[1].confirmed_index;
        result.highs = [latest.highs[0].price, latest.highs[1].price];
      } else {
        lineDirection = "bullish";
        trendline = calculateTrendline(latest.lows[0], latest.lows[1]);
        structureConfirmedIndex = latest.lows[1].confirmed_index;
        result.lows = [latest.lows[0].price, latest.lows[1].price];
      }
    } else if (bearishStructure) {
      lineDirection = "bearish";
      trendline = calculateTrendline(latest.highs[0], latest.highs[1]);
      structureConfirmedIndex = latest.highs[1].confirmed_index;
      result.highs = [latest.highs[0].price, latest.highs[1].price];
    } else if (bullishStructure) {
      lineDirection = "bullish";
      trendline = calculateTrendline(latest.lows[0], latest.lows[1]);
      structureConfirmedIndex = latest.lows[1].confirmed_index;
      result.lows = [latest.lows[0].price, latest.lows[1].price];
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

    const tradeDirection = breakout.direction;

    const pullback = detectFirstPullback(
      candles,
      tradeDirection,
      breakout.index,
      CONFIG.BREAKOUT_CONFIRMATION_BARS,
      breakout.zoneLow,
      breakout.zoneHigh
    );

    if (!pullback) {
      result.reasons.push("اولین پولبک در محدوده شکست یافت نشد");
      return result;
    }

    const zoneLow = breakout.zoneLow;
    const zoneHigh = breakout.zoneHigh;
    const zoneWidth = zoneHigh - zoneLow;

    if (!Number.isFinite(zoneWidth) || zoneWidth <= 0) {
      result.reasons.push("عرض محدوده شکست معتبر نیست");
      return result;
    }

    const isBullish = tradeDirection === "bullish";
    const entry = (zoneHigh + zoneLow) / 2;
    
    const priceDecimals = getPriceDecimals(result.current_price);
    const tickSize = 10 ** -priceDecimals;
    const pipOffset = CONFIG.STOP_PIPS_OFFSET * tickSize;

    let stopLoss;
    if (isBullish) {
      stopLoss = zoneLow - pipOffset;
    } else {
      stopLoss = zoneHigh + pipOffset;
    }

    const risk = Math.abs(entry - stopLoss);

    if (!Number.isFinite(risk) || risk <= 0) {
      result.reasons.push("محاسبه ریسک معتبر نیست");
      return result;
    }

    const targetDistance = zoneWidth * CONFIG.TARGET_ZONE_MULTIPLIER;
    let takeProfit;
    if (isBullish) {
      takeProfit = zoneHigh + targetDistance;
    } else {
      takeProfit = zoneLow - targetDistance;
    }

    const reward = Math.abs(takeProfit - entry);

    if (!Number.isFinite(reward) || reward <= 0) {
      result.reasons.push("محاسبه تارگت معتبر نیست");
      return result;
    }

    result.direction = tradeDirection;
    result.zone_low = zoneLow;
    result.zone_high = zoneHigh;
    result.zone_width = zoneWidth;
    result.entry = entry;
    result.stop_loss = stopLoss;
    result.take_profit = takeProfit;
    result.rr = reward / risk;
    result.signal_candle_time = pullback.candle.time;
    result.status = isBullish ? "LONG" : "SHORT";

    return result;
  } catch (e) {
    result.reasons.push("خطا در تحلیل: " + ((e && e.message) || "unknown"));
    return result;
  }
}
