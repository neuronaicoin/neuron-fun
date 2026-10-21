#!/usr/bin/env bash
# Sets the race factory's launch market cap on all four chains (RaceFactory.setSettings), keeping
# minFirstBuy and moveFeeBps as they are, then reads it back.
#
# Why (Oct 21 2026): a coin launched on N chains gets 1/N of the supply on each chain; after the
# race the losing chains' unsold coins are burned, so the winner's market cap is the launch price
# x 1B / N. With $12,000 a 4-chain race ends at ~$3,000 (what screeners show), 2 chains ~$6,000,
# a single-chain coin starts at $12,000.
# The value is in 6-decimal dollars on every chain (the unit the builders expect, see bnbmcfix.sh)
# and must be the SAME on every chain: the race hub compares each chain's start settings, a coin
# launched while they differ can't be decided. Only coins launched after the change are affected.
#
# MODE=dry-run: each chain is copied (anvil --fork-url) and the change runs there as the owner,
#   then it is read back. Nothing is sent.
# MODE=apply:   sent for real with PRIVATE_KEY (the factory owner).
# FACTORY: the factory (default v8: same address on every chain). WANT: the new value.

set -uo pipefail
MODE="${MODE:-dry-run}"
REPORT="${REPORT:-/dev/stdout}"
FACTORY="${FACTORY:-0x1Fe532901FE7c66251E55606021b4F2A7e12ABaa}"
WANT="${WANT:-12000000000}"
CHAINS="8453 56 4663 5042"
declare -A RPC NAME FORK PIDS
RPC[8453]="${RPC_8453:-https://mainnet.base.org}";               NAME[8453]="Base"
RPC[56]="${RPC_56:-https://bsc-dataseed.bnbchain.org}";           NAME[56]="BNB"
RPC[4663]="${RPC_4663:-https://rpc.mainnet.chain.robinhood.com}"; NAME[4663]="Robinhood"
RPC[5042]="${RPC_5042:-https://rpc.mainnet.arc.io}";              NAME[5042]="Arc"

say() { echo "$*" >> "$REPORT"; }
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done; }
trap cleanup EXIT
fail() { say ""; say "**STOPPED: $***"; exit 1; }
c() { local out; for i in 1 2 3 4 5; do out=$(cast "$@" 2>/dev/null) && { echo "$out" | awk '{print $1}'; return 0; }; sleep 3; done; echo "ERR"; }
lc() { echo "$1" | tr 'A-F' 'a-f'; }

[[ "$WANT" =~ ^[0-9]+$ ]] || fail "WANT must be a number"
# a sanity range in 6-decimal dollars: $1,000 .. $1,000,000
[ "$WANT" -ge 1000000000 ] && [ "$WANT" -le 1000000000000 ] || fail "WANT $WANT is outside \$1,000..\$1,000,000 (6-decimal dollars)"

say "## Launch market cap: \$$((WANT / 1000000)) on all four chains ($MODE)"
say ""
say "Factory \`$FACTORY\`"
say ""
say "| chain | owner | startMarketCap now | minFirstBuy | moveFeeBps |"
say "|---|---|---|---|---|"
declare -A OWN MFB MOVE
OWNER=""
for a in $CHAINS; do
  OWN[$a]=$(lc "$(c call "$FACTORY" "owner()(address)" --rpc-url "${RPC[$a]}")")
  smc=$(c call "$FACTORY" "startMarketCap()(uint256)" --rpc-url "${RPC[$a]}")
  MFB[$a]=$(c call "$FACTORY" "minFirstBuy()(uint256)" --rpc-url "${RPC[$a]}")
  MOVE[$a]=$(c call "$FACTORY" "moveFeeBps()(uint16)" --rpc-url "${RPC[$a]}")
  for v in "${OWN[$a]}" "$smc" "${MFB[$a]}" "${MOVE[$a]}"; do [ "$v" = "ERR" ] || [ "$v" = "err" ] && fail "${NAME[$a]}: can't read the factory"; done
  say "| ${NAME[$a]} | \`${OWN[$a]}\` | $smc | ${MFB[$a]} | ${MOVE[$a]} |"
  [ -z "$OWNER" ] && OWNER=${OWN[$a]}
  [ "$OWNER" = "${OWN[$a]}" ] || fail "the owner differs between chains"
done

if [ "$MODE" = "apply" ]; then
  [ -n "${PRIVATE_KEY:-}" ] || fail "no PRIVATE_KEY"
  me=$(lc "$(cast wallet address --private-key "$PRIVATE_KEY")")
  [ "$me" = "$OWNER" ] || fail "the key is $me, not the owner $OWNER"
fi

say ""
for a in $CHAINS; do
  if [ "$MODE" = "apply" ]; then
    FORK[$a]="${RPC[$a]}"
    out=$(cast send --rpc-url "${FORK[$a]}" --private-key "$PRIVATE_KEY" "$FACTORY" "setSettings(uint256,uint256,uint16)" "$WANT" "${MFB[$a]}" "${MOVE[$a]}" 2>&1)
  else
    port=$((18900 + RANDOM % 300))
    anvil --fork-url "${RPC[$a]}" --port $port --auto-impersonate --silent --no-rate-limit > /tmp/anvil_mc_$a.log 2>&1 &
    PIDS[$a]=$!
    FORK[$a]="http://127.0.0.1:$port"
    for i in $(seq 1 60); do cast chain-id --rpc-url "${FORK[$a]}" >/dev/null 2>&1 && break; sleep 1; done
    cast rpc anvil_setBalance "$OWNER" 0x56BC75E2D63100000 --rpc-url "${FORK[$a]}" >/dev/null 2>&1
    out=$(cast send --rpc-url "${FORK[$a]}" --unlocked --from "$OWNER" "$FACTORY" "setSettings(uint256,uint256,uint16)" "$WANT" "${MFB[$a]}" "${MOVE[$a]}" 2>&1)
  fi
  if echo "$out" | grep -qE "^status +1"; then
    say "- ${NAME[$a]}: set \`$(echo "$out" | awk '/^transactionHash/{print $2}')\`"
  else
    say "- ${NAME[$a]}: **failed**"; say '```'; echo "$out" | tail -8 >> "$REPORT"; say '```'
    fail "${NAME[$a]}: setSettings failed (the chains before it were changed: run again to finish)"
  fi
done

say ""; say "Read back:"
bad=0
for a in $CHAINS; do
  for t in 1 2 3 4 5; do
    s=$(c call "$FACTORY" "startMarketCap()(uint256)" --rpc-url "${FORK[$a]}")
    m=$(c call "$FACTORY" "minFirstBuy()(uint256)" --rpc-url "${FORK[$a]}")
    f=$(c call "$FACTORY" "moveFeeBps()(uint16)" --rpc-url "${FORK[$a]}")
    [ "$s" = "$WANT" ] && [ "$m" = "${MFB[$a]}" ] && [ "$f" = "${MOVE[$a]}" ] && break
    sleep 3
  done
  if [ "$s" = "$WANT" ] && [ "$m" = "${MFB[$a]}" ] && [ "$f" = "${MOVE[$a]}" ]; then say "- ${NAME[$a]}: startMarketCap $s, minFirstBuy $m, moveFeeBps $f: ok"
  else bad=1; say "- ${NAME[$a]}: **MISMATCH** startMarketCap $s minFirstBuy $m moveFeeBps $f"; fi
done
say ""
[ $bad = 0 ] && say "**ALL OK ($MODE).**" || { say "**SOMETHING DIDN'T MATCH.**"; exit 1; }
