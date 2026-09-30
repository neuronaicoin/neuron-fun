// Help desk: anyone can write in from /help; admins read and answer from /admin.
// Answers go out by email through Resend when RESEND_API_KEY is set.
//
//   POST /api/help                 { name, email, message, page?, website? }  (public)
//   GET  /api/help/list?status=    admin: latest tickets
//   POST /api/help/reply           admin: { id, reply }  -> emails the answer
//   POST /api/help/close           admin: { id }
//
// Env: RESEND_API_KEY, SUPPORT_FROM ("sasa support <support@sasapad.fun>"),
//      SUPPORT_NOTIFY (your inbox: told about every new message; optional)

import { admins, sec } from "./forum-core.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (status, error) => json({ error }, status);
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendMail(env, { to, subject, text, html, replyTo }) {
  if (!env.RESEND_API_KEY) return { sent: false, reason: "RESEND_API_KEY is not set" };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.SUPPORT_FROM || "sasa support <support@sasapad.fun>",
      to: [to],
      subject,
      text,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!r.ok) return { sent: false, reason: `Resend ${r.status}: ${(await r.text()).slice(0, 200)}` };
  return { sent: true };
}

/** Public: a new message from the help form. */
export async function submitHelp(env, request, body, me) {
  // A hidden "website" field only bots fill in.
  if (typeof body.website === "string" && body.website.trim()) return json({ ok: true });
  const name = String(body.name ?? "").trim().slice(0, 80);
  const email = String(body.email ?? "").trim().toLowerCase().slice(0, 200);
  const message = String(body.message ?? "").trim();
  const page = String(body.page ?? "").slice(0, 200);
  if (name.length < 2) return fail(400, "Please add your name.");
  if (!EMAIL.test(email)) return fail(400, "That email doesn't look right.");
  if (message.length < 10) return fail(400, "Please tell us a bit more (at least 10 characters).");
  if (message.length > 4000) return fail(400, "That's a long one: please keep it under 4,000 characters.");

  const ip = request.headers.get("cf-connecting-ip") || "";
  const ipHash = ip ? await sha256(`${env.SESSION_SECRET || ""}:${ip}`) : null;
  // At most 5 messages an hour per email or network.
  const since = new Date(Date.now() - 3600e3).toISOString();
  const recent = await sec(
    env,
    `support_tickets?select=id&created_at=gte.${encodeURIComponent(since)}&or=(email.eq.${encodeURIComponent(email)}${ipHash ? `,ip_hash.eq.${ipHash}` : ""})`
  );
  if (Array.isArray(recent) && recent.length >= 5) return fail(429, "You've sent a few messages already. We'll get back to you soon.");

  const rows = await sec(env, "support_tickets", {
    method: "POST",
    body: { name, email, message, page: page || null, wallet: me || null, ip_hash: ipHash },
    prefer: "return=representation",
  });
  const id = Array.isArray(rows) && rows[0] ? rows[0].id : null;
  if (env.SUPPORT_NOTIFY) {
    await sendMail(env, {
      to: env.SUPPORT_NOTIFY,
      subject: `sasa help #${id}: ${name}`,
      text: `${name} <${email}>${me ? ` (wallet ${me})` : ""}\n\n${message}\n\nAnswer at https://sasapad.fun/admin/`,
      replyTo: email,
    }).catch(() => {});
  }
  return json({ ok: true, id });
}

/** Admin: list, reply, close. */
export async function adminHelp(env, me, parts, method, body, url) {
  if (!admins(env).includes(me)) return fail(403, "Admins only.");
  if (parts[1] === "list" && method === "GET") {
    const status = url.searchParams.get("status");
    const filter = status && ["open", "answered", "closed"].includes(status) ? `&status=eq.${status}` : "";
    const rows = await sec(env, `support_tickets?select=id,created_at,name,email,message,wallet,page,status,reply,replied_at&order=created_at.desc&limit=200${filter}`);
    return json({ tickets: rows ?? [], mail: !!env.RESEND_API_KEY });
  }
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return fail(400, "Which message?");
  const found = await sec(env, `support_tickets?select=id,name,email,message&id=eq.${id}`);
  const t = Array.isArray(found) ? found[0] : null;
  if (!t) return fail(404, "Message not found.");
  if (parts[1] === "reply" && method === "POST") {
    const reply = String(body.reply ?? "").trim();
    if (reply.length < 2 || reply.length > 8000) return fail(400, "Write a reply first.");
    const mail = await sendMail(env, {
      to: t.email,
      subject: `Re: your message to sasa (#${t.id})`,
      text: `Hi ${t.name},\n\n${reply}\n\n— sasa support\n\nYour message:\n> ${t.message.replace(/\n/g, "\n> ")}`,
      html: `<p>Hi ${esc(t.name)},</p><p>${esc(reply).replace(/\n/g, "<br>")}</p><p>— sasa support</p><hr><p style="color:#777">Your message:<br>${esc(t.message).replace(/\n/g, "<br>")}</p>`,
    });
    await sec(env, `support_tickets?id=eq.${id}`, {
      method: "PATCH",
      body: { status: "answered", reply, replied_at: new Date().toISOString(), replied_by: me },
    });
    return json({ ok: true, emailed: mail.sent, reason: mail.sent ? undefined : mail.reason });
  }
  if (parts[1] === "close" && method === "POST") {
    await sec(env, `support_tickets?id=eq.${id}`, { method: "PATCH", body: { status: "closed" } });
    return json({ ok: true });
  }
  return fail(404, "Not found.");
}
