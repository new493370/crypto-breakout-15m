function fmtPrice(value) {
  if (value === null || value === undefined) return "-";

  const v = Number(value);

  if (!Number.isFinite(v)) return "-";
  if (v >= 1000) return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(4);
  if (v >= 0.01) return v.toFixed(6);

  return v.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
}

function statusIcon(status) {
  if (status === "LONG") return "🟢";
  if (status === "SHORT") return "🔴";
  if (status === "WAIT") return "🟡";
  return "⚪";
}

function statusText(status) {
  return {
    LONG: "خرید",
    SHORT: "فروش",
    WAIT: "صبر",
    NO_TRADE: "بدون معامله"
  }[status] || status;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatAnalysis(result) {
  const lines = [];

  lines.push(statusIcon(result.status) + " <b>" + escapeHtml(result.symbol) + "</b>");
  lines.push("⏱ تایم‌فریم: <b>" + escapeHtml(result.timeframe) + "</b>");
  lines.push("📌 وضعیت: <b>" + statusText(result.status) + "</b>");
  lines.push("");
  lines.push("💰 قیمت آخرین کندل بسته‌شده: <b>" + fmtPrice(result.current_price) + "</b>");

  if (result.direction) {
    const isBullish = result.direction === "bullish";

    lines.push("");
    lines.push("📌 جهت: <b>" + (isBullish ? "🟢 خرید (LONG)" : "🔴 فروش (SHORT)") + "</b>");
    lines.push("📊 محدوده شکست: <b>" + fmtPrice(result.zone_low) + " — " + fmtPrice(result.zone_high) + "</b>");
    lines.push("📏 عرض محدوده: <b>" + fmtPrice(result.zone_width) + "</b>");
    lines.push("🎯 ورود: <b>" + fmtPrice(result.entry) + "</b>");
    lines.push("🛑 حد ضرر: <b>" + fmtPrice(result.stop_loss) + "</b>");
    lines.push("🥇 حد سود: <b>" + fmtPrice(result.take_profit) + "</b>");
    lines.push("⚖️ نسبت سود به ریسک: <b>" + Number(result.rr).toFixed(2) + "R</b>");
  }

  if (Array.isArray(result.reasons) && result.reasons.length > 0) {
    lines.push("");
    for (const reason of result.reasons) {
      lines.push("• " + escapeHtml(reason));
    }
  }

  lines.push("");
  lines.push("<b>⚠️ خروجی بر اساس داده‌های کندل بسته‌شده است و تضمین سود نیست.</b>");

  return lines.join("\n");
}

export function formatSignalResult(signal, newStatus) {
  const isBullish = signal.direction === "bullish";
  const directionText = isBullish ? "🟢 خرید (LONG)" : "🔴 فروش (SHORT)";

  if (newStatus === "stopped") {
    return [
      "🛑 <b>حد ضرر فعال شد</b>",
      "━━━━━━━━━━━━━━━━━━━━━━",
      "🔸 ارز: <b>" + escapeHtml(signal.symbol) + "</b>",
      "⏱ تایم‌فریم: <b>" + escapeHtml(signal.timeframe) + "</b>",
      "📌 جهت: " + directionText,
      "💰 نتیجه معامله: <b>-1R</b>"
    ].join("\n");
  }

  if (newStatus === "tp1_hit") {
    return [
      "✅ <b>تارگت با موفقیت زده شد</b>",
      "━━━━━━━━━━━━━━━━━━━━━━",
      "🔸 ارز: <b>" + escapeHtml(signal.symbol) + "</b>",
      "⏱ تایم‌فریم: <b>" + escapeHtml(signal.timeframe) + "</b>",
      "📌 جهت: " + directionText,
      "🎯 تارگت: <b>" + fmtPrice(signal.tp1) + "</b>",
      "💰 سود معامله: <b>+" + Number(signal.rr1).toFixed(2) + "R</b>"
    ].join("\n");
  }

  return "";
}
