"use client";

/** Admin: the visitor funnel (lib/funnel.ts → /api/fstats). Where visitors come from, how far
 * they get (coin page → log in → deposit → buy / sell / launch), where they leave, which errors
 * they saw, and the latest visits step by step. */
import { useCallback, useEffect, useState } from "react";
import { useWallet } from "./wallet";
import { authedGet } from "@/lib/alerts";
import { friendlyError } from "@/lib/format";

type Row = { k: string; n: number };
type Visit = {
  start: string;
  seconds: number;
  mobile: boolean;
  isNew: boolean;
  from: string;
  country: string | null;
  who: string | null;
  steps: string[];
  done: string[];
  errors: string[];
  events: { t: string; ev: string; path: string | null; detail: string | null }[];
};
type Stats = {
  hours: number;
  visits: number;
  devices: number;
  newVisits: number;
  mobile: number;
  bounced: number;
  medianSeconds: number;
  funnel: Record<string, number>;
  from: Row[];
  landing: Row[];
  exits: Row[];
  countries: Row[];
  errors: Row[];
  recent: Visit[];
};

const STEPS: [string, string][] = [
  ["visited", "Siteye girdi"],
  ["openedCoin", "Bir coin sayfası açtı"],
  ["tappedLogin", "Giriş / kayıt butonuna bastı"],
  ["loggedIn", "Giriş yaptı"],
  ["tappedDeposit", "Deposit'e bastı"],
  ["tappedBuy", "Buy'a bastı"],
  ["bought", "Aldı ✅"],
  ["tappedSell", "Sell'e bastı"],
  ["sold", "Sattı ✅"],
  ["tappedLaunch", "Coin çıkarmaya bastı"],
  ["launched", "Coin çıkardı ✅"],
];
const time = (s: string) => new Date(s).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
const dur = (s: number) => (s < 60 ? `${s} sn` : `${Math.round(s / 60)} dk`);

function List({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div className="rounded-xl border border-line p-3">
      <p className="text-[0.8125rem] font-semibold mb-2">{title}</p>
      {rows.length === 0 && <p className="text-[0.75rem] text-ink-3">—</p>}
      {rows.map((r) => (
        <div key={r.k} className="flex justify-between gap-2 text-[0.75rem] py-0.5">
          <span className="truncate text-ink-2">{r.k || "—"}</span>
          <span className="tabular-nums shrink-0">{r.n}</span>
        </div>
      ))}
    </div>
  );
}

export function FunnelPanel() {
  const { signMessage } = useWallet();
  const [hours, setHours] = useState(24);
  const [s, setS] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setS(await authedGet<Stats>(signMessage, `fstats?h=${hours}`));
      setError("");
    } catch (e) {
      setError(friendlyError(e));
    }
  }, [signMessage, hours]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const max = s?.funnel.visited || 1;
  return (
    <section className="mt-8">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-lg font-bold">Ziyaretçi hunisi</h2>
        <div className="flex gap-1">
          {[1, 6, 24, 168].map((h) => (
            <button key={h} type="button" onClick={() => setHours(h)} className={"h-8 px-3 rounded-full text-[0.8125rem] border " + (hours === h ? "border-accent text-accent" : "border-line text-ink-2")}>
              {h === 168 ? "7 gün" : `${h} saat`}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="mt-2 text-[0.8125rem] text-danger">{error}</p>}
      {!s && !error && <p className="mt-2 text-[0.8125rem] text-ink-3">Yükleniyor…</p>}
      {s && (
        <>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              ["Ziyaret", s.visits],
              ["Farklı cihaz", s.devices],
              ["İlk kez gelen", s.newVisits],
              ["Mobil", s.mobile],
              ["Hemen çıkan", s.bounced],
              ["Ortalama süre", dur(s.medianSeconds)],
            ].map(([k, v]) => (
              <div key={String(k)} className="rounded-xl border border-line p-3">
                <p className="text-[0.75rem] text-ink-3">{k}</p>
                <p className="text-xl font-bold tabular-nums">{v}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 rounded-xl border border-line p-3">
            <p className="text-[0.8125rem] font-semibold mb-2">Adım adım (kaç ziyaret bu adıma geldi)</p>
            {STEPS.map(([k, label]) => {
              const n = s.funnel[k] ?? 0;
              return (
                <div key={k} className="flex items-center gap-2 py-1">
                  <span className="w-44 shrink-0 text-[0.75rem] text-ink-2 truncate">{label}</span>
                  <div className="flex-1 h-3 rounded-full bg-line/40 overflow-hidden">
                    <div className="h-full bg-accent" style={{ width: `${Math.max(n ? 2 : 0, (n / max) * 100)}%` }} />
                  </div>
                  <span className="w-16 shrink-0 text-right text-[0.75rem] tabular-nums">
                    {n} <span className="text-ink-3">{s.funnel.visited ? `${Math.round((n / s.funnel.visited) * 100)}%` : ""}</span>
                  </span>
                </div>
              );
            })}
          </div>

          <div className="mt-4 grid sm:grid-cols-2 gap-2">
            <List title="Nereden geldiler" rows={s.from} />
            <List title="Son gördükleri sayfa (çıkış)" rows={s.exits} />
            <List title="İlk açtıkları sayfa" rows={s.landing} />
            <List title="Ülke" rows={s.countries} />
          </div>
          <div className="mt-2">
            <List title="Gördükleri hatalar" rows={s.errors} />
          </div>

          <div className="mt-4 rounded-xl border border-line p-3">
            <p className="text-[0.8125rem] font-semibold mb-2">Son ziyaretler (dokun: adım adım ne yaptı)</p>
            {s.recent.length === 0 && <p className="text-[0.75rem] text-ink-3">Henüz ziyaret yok.</p>}
            {s.recent.map((v, i) => (
              <div key={i} className="border-t border-line first:border-t-0 py-2">
                <button type="button" onClick={() => setOpen(open === i ? null : i)} className="w-full text-left text-[0.75rem] flex flex-wrap gap-x-2 gap-y-0.5">
                  <span className="tabular-nums">{time(v.start)}</span>
                  <span className="text-ink-2">{v.mobile ? "📱" : "💻"} {v.isNew ? "yeni" : "tekrar"} · {v.country || "?"} · {v.from} · {dur(v.seconds)}</span>
                  {v.who && <span className="text-accent">giriş yaptı</span>}
                  {v.steps.length > 0 && <span>bastı: {v.steps.join(", ")}</span>}
                  {v.done.length > 0 && <span className="text-[color:var(--up,#16a34a)]">✅ {v.done.join(", ")}</span>}
                  {v.errors.length > 0 && <span className="text-danger">hata: {v.errors.length}</span>}
                </button>
                {open === i && (
                  <ol className="mt-1 ml-3 text-[0.6875rem] text-ink-2 space-y-0.5">
                    {v.events.map((e, j) => (
                      <li key={j} className="break-words">
                        <span className="tabular-nums text-ink-3">{time(e.t)}</span> <b>{e.ev}</b> {e.path} {e.detail && <span className="text-ink-3">— {e.detail}</span>}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
