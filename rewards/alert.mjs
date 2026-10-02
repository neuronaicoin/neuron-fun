// Tells the team when something needs a human: Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)
// and/or email through Resend (RESEND_API_KEY + ALERT_EMAIL). Nothing set: alerts only go to
// the log. The same alert is sent at most once per ALERT_EVERY_MIN minutes (default 60).
const last = new Map();
const EVERY = Number(process.env.ALERT_EVERY_MIN ?? "60") * 60_000;

export async function alert(service, key, text) {
  const now = Date.now();
  if (now - (last.get(key) ?? 0) < EVERY) return;
  last.set(key, now);
  const msg = `⚠️ sasa ${service}: ${text}`;
  console.log(new Date().toISOString(), "ALERT", msg);
  const tasks = [];
  const tg = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (tg && chat) {
    tasks.push(
      fetch(`https://api.telegram.org/bot${tg}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: msg }),
      })
    );
  }
  const rk = process.env.RESEND_API_KEY, to = process.env.ALERT_EMAIL;
  if (rk && to) {
    tasks.push(
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${rk}` },
        body: JSON.stringify({ from: process.env.ALERT_FROM ?? "sasa alerts <alerts@sasapad.fun>", to, subject: `sasa ${service} alert`, text: msg }),
      })
    );
  }
  await Promise.allSettled(tasks);
}
