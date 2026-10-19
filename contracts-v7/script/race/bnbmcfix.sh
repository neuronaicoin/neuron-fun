#!/usr/bin/env bash
# Fixes the BNB Chain race factory's launch market cap (Oct 19 2026).
#
# Why: every chain's factory keeps startMarketCap in 6-decimal dollars (3000000000 = $3,000), the
# unit RaceBuilder/RaceBuilderPcs expect (REPORT_DECIMALS = 6). BNB Chain's was deployed with
# 3000000000000000000000 (18 decimals, like BSC's USDT). Two effects:
#   - BNB coins opened at an absurd price (almost nobody could buy there);
#   - the race hub compares every chain's start settings (setHash); BNB's never matched, so a
#     race with BNB never got all its reports counted and was never decided (Chain Cat, Panda
#     Space, ...). Those coins keep trading on every chain.
# This sets BNB's startMarketCap to 3000000000 and keeps minFirstBuy and moveFeeBps as they are.
# Only NEW coins are affected (each coin's seat keeps the value it was made with).
#
# MODE=dry-run: BNB Chain is copied (anvil --fork-url) and the change runs there as the real
#   owner, then it is read back. Nothing is sent.
# MODE=apply:   sent for real with whichever of PRIVATE_KEY / FACTORY_KEY owns the factory.

set -uo pipefail
MODE="${MODE:-dry-run}"
REPORT="${REPORT:-/dev/stdout}"
FACTORY=0x88e21D24C35034f80E854efBD5ACD16507a9169B
RPC="${RPC_56:-https://bsc-dataseed.bnbchain.org}"
WANT=3000000000

say() { echo "$*" >> "$REPORT"; }
fail() { say ""; say "**STOPPED: $***"; [ -n "${APID:-}" ] && kill "$APID" 2>/dev/null; exit 1; }
c() { local out; for i in 1 2 3 4 5; do out=$(cast "$@" 2>/dev/null) && { echo "$out" | awk '{print $1}'; return 0; }; sleep 3; done; echo "ERR"; }
lc() { echo "$1" | tr 'A-F' 'a-f'; }

say "## BNB Chain factory: launch market cap fix ($MODE)"
OWNER=$(c call $FACTORY "owner()(address)" --rpc-url "$RPC")
SMC=$(c call $FACTORY "startMarketCap()(uint256)" --rpc-url "$RPC")
MFB=$(c call $FACTORY "minFirstBuy()(uint256)" --rpc-url "$RPC")
MOVE=$(c call $FACTORY "moveFeeBps()(uint16)" --rpc-url "$RPC")
for v in "$OWNER" "$SMC" "$MFB" "$MOVE"; do [ "$v" = "ERR" ] && fail "could not read the factory on BNB Chain"; done
say ""
say "| | now |"
say "|---|---|"
say "| owner | \`$OWNER\` |"
say "| startMarketCap | $SMC |"
say "| minFirstBuy | $MFB |"
say "| moveFeeBps | $MOVE |"
if [ "$SMC" = "$WANT" ]; then say ""; say "startMarketCap is already $WANT: nothing to do."; exit 0; fi
[ "$SMC" = "3000000000000000000000" ] || fail "startMarketCap is $SMC, not the expected 3000000000000000000000; not touching it"

if [ "$MODE" = "apply" ]; then
  KEY=""
  for k in "${PRIVATE_KEY:-}" "${FACTORY_KEY:-}"; do
    [ -z "$k" ] && continue
    a=$(cast wallet address --private-key "$k" 2>/dev/null)
    [ "$(lc "$a")" = "$(lc "$OWNER")" ] && KEY="$k"
  done
  [ -n "$KEY" ] || fail "neither MAINNET_DEPLOYER_KEY nor MAINNET_RACE_FACTORY_KEY is the factory's owner ($OWNER)"
  TX=$(cast send $FACTORY "setSettings(uint256,uint256,uint16)" $WANT "$MFB" "$MOVE" --private-key "$KEY" --rpc-url "$RPC" --json 2>&1) || fail "the transaction failed: $TX"
  HASH=$(echo "$TX" | jq -r '.transactionHash // empty')
  STATUS=$(echo "$TX" | jq -r '.status // empty')
  [ "$STATUS" = "0x1" ] || [ "$STATUS" = "1" ] || fail "the transaction reverted ($HASH)"
  say ""; say "Sent: https://bscscan.com/tx/$HASH"
  CHECK_RPC="$RPC"
else
  anvil --fork-url "$RPC" --port 8645 --silent >/dev/null 2>&1 &
  APID=$!
  for i in $(seq 1 60); do cast block-number --rpc-url http://127.0.0.1:8645 >/dev/null 2>&1 && break; sleep 1; done
  cast rpc anvil_impersonateAccount "$OWNER" --rpc-url http://127.0.0.1:8645 >/dev/null || fail "anvil did not start"
  cast rpc anvil_setBalance "$OWNER" 0x56BC75E2D63100000 --rpc-url http://127.0.0.1:8645 >/dev/null
  cast send $FACTORY "setSettings(uint256,uint256,uint16)" $WANT "$MFB" "$MOVE" --from "$OWNER" --unlocked --rpc-url http://127.0.0.1:8645 >/dev/null 2>&1 \
    || fail "setSettings reverted on the copy"
  CHECK_RPC=http://127.0.0.1:8645
fi

S2=$(c call $FACTORY "startMarketCap()(uint256)" --rpc-url "$CHECK_RPC")
M2=$(c call $FACTORY "minFirstBuy()(uint256)" --rpc-url "$CHECK_RPC")
F2=$(c call $FACTORY "moveFeeBps()(uint16)" --rpc-url "$CHECK_RPC")
[ -n "${APID:-}" ] && kill "$APID" 2>/dev/null
say ""
say "| | after |"
say "|---|---|"
say "| startMarketCap | $S2 |"
say "| minFirstBuy | $M2 |"
say "| moveFeeBps | $F2 |"
[ "$S2" = "$WANT" ] && [ "$M2" = "$MFB" ] && [ "$F2" = "$MOVE" ] || fail "read-back does not match"
say ""
if [ "$MODE" = "apply" ]; then say "**Done.** New BNB Chain coins now open at \$3,000 and their races finish like the other chains'."
else say "**Dry run OK.** Run again with mode = apply and confirm = APPLY to send it."; fi
