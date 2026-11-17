"use client";
import { ConnectButton } from "./chrome";

/** In the buy sheet, before the amount: a visitor who isn't signed in sees first what to do
 * (on a small phone the button under the keypad can be out of sight). */
export function SignInToBuy({ symbol }: { symbol: string }) {
  return (
    <div className="mt-3 rounded-2xl border border-[#ff6b1a]/40 bg-[#ff6b1a]/10 p-3">
      <p className="text-[0.8125rem] text-ink-2 mb-2">
        <b className="text-ink">Log in to buy ${symbol}.</b> Free with email, no wallet setup, about 30 seconds.
      </p>
      <ConnectButton full />
    </div>
  );
}
