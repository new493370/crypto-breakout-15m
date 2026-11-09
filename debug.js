import { CONFIG } from "./src/config.js";
import { getMarketSnapshot } from "./src/exchanges.js";
import {
  detectSwings,
  getLatestMinorSwings,
  isValidStructure,
  calculateTrendline,
  detectBreakout,
  detectEngulfing,
  calculateEMA
} from "./src/indicators.js";

const SYMBOL = "XRPUSDT";

async function runDebug() {
  console.log("═══════════════════════════════════════════");
  console.log("🔍 دیباگ کامل برای ارز: " + SYMBOL);
  console.log("═══════════════════════════════════════════\n");

  try {
    const snapshot = await getMarketSnapshot(SYMBOL, CONFIG.TIMEFRAME);
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

    console.log("✅ تعداد کندل‌های بسته‌شده:", candles.length);
    if (candles.length < CONFIG.MIN_CANDLES) {
      console.log("❌ تعداد کندل‌ها کمتر از حداقل است.");
      return;
    }

    const lastCandle = candles[candles.length - 1];
    console.log("💰 قیمت آخرین کندل:", lastCandle.close);

    // ۱. بررسی EMA 50
    const ema50 = calculateEMA(candles, 50);
    console.log("\n📊 EMA 50:", ema50 ? ema50.toFixed(4) : "null");
    if (ema50) {
      console.log("📌 قیمت بالای EMA 50 است؟", lastCandle.close > ema50 ? "✅ بله (روند صعودی)" : "❌ خیر (روند نزولی)");
    }

    // ۲. بررسی سقف/کف‌ها
    const swings = detectSwings(candles);
    console.log("\n📈 تعداد سقف‌های پیدا شده:", swings.highs.length);
    console.log("📉 تعداد کف‌های پیدا شده:", swings.lows.length);

    const latest = getLatestMinorSwings(swings, 2);
    console.log("\n🔹 دو سقف آخر:");
    latest.highs.forEach((h, idx) => console.log(`   سقف ${idx + 1}: قیمت ${h.price} در کندل ${h.index}`));
    console.log("🔸 دو کف آخر:");
    latest.lows.forEach((l, idx) => console.log(`   کف ${idx + 1}: قیمت ${l.price} در کندل ${l.index}`));

    if (latest.highs.length < 2 || latest.lows.length < 2) {
      console.log("\n❌ تعداد سقف یا کف کمتر از ۲ عدد است. تحلیل متوقف شد.");
      return;
    }

    // ۳. بررسی ساختار
    const bearishStructure = isValidStructure(latest.highs[0], latest.highs[1], "bearish");
    const bullishStructure = isValidStructure(latest.lows[0], latest.lows[1], "bullish");

    console.log("\n🏗 بررسی ساختار:");
    console.log("   ساختار نزولی (Lower High):", bearishStructure ? "✅ معتبر" : "❌ نامعتبر");
    console.log("   ساختار صعودی (Higher Low):", bullishStructure ? "✅ معتبر" : "❌ نامعتبر");

    if (!bearishStructure && !bullishStructure) {
      console.log("\n❌ هیچ ساختار معتبری وجود ندارد. تحلیل متوقف شد.");
      return;
    }

    // ۴. خط روند
    let lineDirection = null;
    let trendline = null;
    let structureConfirmedIndex = -1;

    if (bearishStructure && bullishStructure) {
      if (latest.highs[1].confirmed_index >= latest.lows[1].confirmed_index) {
        lineDirection = "bearish";
        trendline = calculateTrendline(latest.highs[0], latest.highs[1]);
        structureConfirmedIndex = latest.highs[1].confirmed_index;
      } else {
        lineDirection = "bullish";
        trendline = calculateTrendline(latest.lows[0], latest.lows[1]);
        structureConfirmedIndex = latest.lows[1].confirmed_index;
      }
    } else if (bearishStructure) {
      lineDirection = "bearish";
      trendline = calculateTrendline(latest.highs[0], latest.highs[1]);
      structureConfirmedIndex = latest.highs[1].confirmed_index;
    } else if (bullishStructure) {
      lineDirection = "bullish";
      trendline = calculateTrendline(latest.lows[0], latest.lows[1]);
      structureConfirmedIndex = latest.lows[1].confirmed_index;
    }

    console.log("\n📏 خط روند:");
    console.log("   جهت:", lineDirection);
    console.log("   شیب:", trendline ? trendline.slope.toFixed(6) : "null");

    // ۵. شکست
    const breakout = detectBreakout(candles, trendline, lineDirection, structureConfirmedIndex + 1);

    console.log("\n💥 شکست خط روند:");
    if (!breakout) {
      console.log("   ❌ شکست معتبر رخ نداده است.");
      return;
    }
    console.log("   ✅ شکست رخ داد در کندل", breakout.index);
    console.log("   جهت معامله:", breakout.direction);
    console.log("   محدوده شکست:", breakout.zoneLow, "—", breakout.zoneHigh);
    console.log("   عرض محدوده:", breakout.zoneWidth);

    // ۶. فیلتر مومنتوم (اینجا چک نمی‌کنیم، ولی اگه لازم شد اضافه می‌کنیم)
    
    // ۷. اینگولف
    const engulf = detectEngulfing(
      candles,
      breakout.direction,
      breakout.index,
      CONFIG.BREAKOUT_CONFIRMATION_BARS,
      breakout.zoneLow,
      breakout.zoneHigh
    );

    console.log("\n🕯 بررسی اینگولف:");
    if (!engulf) {
      console.log("   ❌ کندل اینگولف معتبر در محدوده شکست یافت نشد.");
    } else {
      console.log("   ✅ اینگولف در کندل", engulf.index);
      console.log("   قیمت ورود:", engulf.entryPrice);
    }

    console.log("\n═══════════════════════════════════════════");
    console.log("✅ دیباگ کامل شد.");
    console.log("═══════════════════════════════════════════");

  } catch (e) {
    console.error("❌ خطا:", e);
  }
}

runDebug();
