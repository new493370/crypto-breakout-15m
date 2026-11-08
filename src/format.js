function fmtPrice(value) {
  if (value === null || value === undefined) return "-";
  const v = parseFloat(value);
  if (!Number.isFinite(v)) return "-";
  if (v >= 1000) return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(4);
  if (v >= 0.01) return v.toFixed(5);
  return v.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function statusIcon(s) {
  if (s === "LONG") return "🟢";
  if (s === "SHORT") return "🔴";
  if (s === "WAIT") return "🟡";
  return "⚪";
}

function statusText(s) {
  return { LONG: "خرید", SHORT: "فروش", WAIT: "صبر", NO_TRADE: "بدون معامله" }[s] || s;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatAnalysis(r) {
  const lines = [];

  lines.push(statusIcon(r.status) + " <b>" + escapeHtml(r.symbol) + "</b>");
  lines.push("⏱ تایم‌فریم: <b>" + escapeHtml(r.timeframe) + "</b>");
  lines.push("📌 وضعیت: <b>" + statusText(r.status) + "</b>");
  lines.push("");
  lines.push("💰 قیمت فعلی: <b>" + fmtPrice(r.current_price) + "</b>");

  if (r.direction) {
    lines.push("");
    lines.push("📌 جهت: <b>" + (r.direction === "bullish" ? "🟢 خرید (Long)" : "🔴 فروش (Short)") + "</b>");
    lines.push("📊 محدوده شکست: <b>" + fmtPrice(r.zone_low) + " — " + fmtPrice(r.zone_high) + "</b>");
    lines.push("🎯 ورود: <b>" + fmtPrice(r.entry) + "</b>");
    lines.push("🛑 حد ضرر: <b>" + fmtPrice(r.stop_loss) + "</b>");
    lines.push("🥇 حد سود: <b>" + fmtPrice(r.take_profit) + "</b> (1:" + r.rr + "R)");
  }

  if (r.reasons && r.reasons.length > 0) {
    lines.push("");
    for (const reason of r.reasons) lines.push("• " + escapeHtml(reason));
  }

  lines.push("");
  lines.push("<b>⚠️ این خروجی تحلیل الگوریتمی است و تضمین سود نیست.</b>");

  return lines.join("\n");
}

export function formatSignalResult(sig, newStatus) {
  const isBullish = sig.direction === "bullish";

  if (newStatus === "stopped") {
    return (
      "🛑 <b>حد ضرر فعال شد</b>\n" +
      "━━━━━━━━━━━━━━━━━━━━━━\n" +
      "🔸 ارز: <b>" + escapeHtml(sig.symbol) + "</b>\n" +
      "⏱ تایم‌فریم: <b>" + escapeHtml(sig.timeframe) + "</b>\n" +
      "📌 جهت: " + (isBullish ? "🟢 خرید (Long)" : "🔴 فروش (Short)") + "\n\n" +
      "💰 ضرر خالص (بدون اهرم): <b>-1R</b>\n\n" +
      "💡 مدیریت سرمایه را رعایت کنید. بازار همیشه فرصت‌های جدیدی دارد."
    );
  }

  if (newStatus === "tp1_hit") {
    return (
      "✅ <b>معامله با موفقیت بسته شد</b>\n" +
      "━━━━━━━━━━━━━━━━━━━━━━\n" +
      "🔸 ارز: <b>" + escapeHtml(sig.symbol) + "</b>\n" +
      "⏱ تایم‌فریم: <b>" + escapeHtml(sig.timeframe) + "</b>\n" +
      "📌 جهت: " + (isBullish ? "🟢 خرید" : "🔴 فروش") + "\n\n" +
      "🎯 تارگت زده شده: <b>TP1</b>\n" +
      "💰 سود خالص (بدون اهرم): <b>+" + sig.rr1 + "R</b>\n\n" +
      "💡 لطفاً حد ضرر خود را مدیریت کنید (حداقل به نقطه ورود)."
    );
  }

  return "";
}
