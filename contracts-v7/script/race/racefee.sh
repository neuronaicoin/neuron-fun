#!/usr/bin/env bash
# Sets the race fee (paid by the creator on each chain a coin opens on, to the keeper, for the
# race's network fees) on all four chains (RaceFactory.setRaceFee), then reads it back.
# CENTS: the fee per chain in US cents (75 = $0.75). It is written in each chain's dollar units
# (6 decimals; 18 on BNB Chain). At most $2 per chain (the factory refuses more).
# FACTORY: v8 by default (0x1Fe5…), v7 is 0x88e2…. MODE=dry-run (copies of the chains) | apply.

set -uo pipefail
MODE="${MODE:-dry-run}"
REPORT="${REPORT:-/dev/stdout}"
FACTORY="${FACTORY:-0x1Fe532901FE7c66251E55606021b4F2A7e12ABaa}"
CENTS="${CENTS:?CENTS=75 for \$0.75}"
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

# CENTS: one number for every chain ("75"), or one per chain ("8453:150,56:125,4663:40,5042:75";
# a chain left out keeps its fee).
declare -A CC
if [[ "$CENTS" =~ ^[0-9]+$ ]]; then
  for a in $CHAINS; do CC[$a]=$CENTS; done
else
  IFS=',' read -ra PARTS <<< "$CENTS"
  for p in "${PARTS[@]}"; do
    [[ "$p" =~ ^(8453|56|4663|5042):([0-9]+)$ ]] || fail "CENTS: \"$p\" isn't chainId:cents (e.g. 8453:150)"
    CC[${BASH_REMATCH[1]}]=${BASH_REMATCH[2]}
  done
fi
for a in $CHAINS; do
  [ -n "${CC[$a]:-}" ] || continue
  [ "${CC[$a]}" -le 200 ] || fail "${NAME[$a]}: at most 200 cents (\$2)"
done

say "## Race fee per chain ($MODE): $CENTS"
say ""; say "Factory \`$FACTORY\`"; say ""
say "| chain | owner | dollar decimals | race fee now | new |"; say "|---|---|---|---|---|"
declare -A WANT
OWNER=""
for a in $CHAINS; do
  own=$(lc "$(c call "$FACTORY" "owner()(address)" --rpc-url "${RPC[$a]}")")
  usdc=$(c call "$FACTORY" "usdc()(address)" --rpc-url "${RPC[$a]}")
  dec=$(c call "$usdc" "decimals()(uint8)" --rpc-url "${RPC[$a]}")
  now=$(c call "$FACTORY" "raceFee()(uint256)" --rpc-url "${RPC[$a]}")
  for v in "$own" "$usdc" "$dec" "$now"; do [ "$v" = "ERR" ] || [ "$v" = "err" ] && fail "${NAME[$a]}: can't read the factory"; done
  if [ -n "${CC[$a]:-}" ]; then WANT[$a]=$(python3 -c "print(${CC[$a]} * 10**$dec // 100)"); else WANT[$a]=$now; fi
  say "| ${NAME[$a]} | \`$own\` | $dec | $now | ${WANT[$a]} |"
  [ -z "$OWNER" ] && OWNER=$own
  [ "$OWNER" = "$own" ] || fail "the owner differs between chains"
done
if [ "$MODE" = "apply" ]; then
  [ -n "${PRIVATE_KEY:-}" ] || fail "no PRIVATE_KEY"
  me=$(lc "$(cast wallet address --private-key "$PRIVATE_KEY")")
  [ "$me" = "$OWNER" ] || fail "the key is $me, not the owner $OWNER"
fi

say ""
for a in $CHAINS; do
  if [ -z "${CC[$a]:-}" ]; then FORK[$a]="${RPC[$a]}"; say "- ${NAME[$a]}: unchanged"; continue; fi
  if [ "$MODE" = "apply" ]; then
    FORK[$a]="${RPC[$a]}"
    out=$(cast send --rpc-url "${FORK[$a]}" --private-key "$PRIVATE_KEY" "$FACTORY" "setRaceFee(uint256)" "${WANT[$a]}" 2>&1)
  else
    port=$((19300 + RANDOM % 300))
    anvil --fork-url "${RPC[$a]}" --port $port --auto-impersonate --silent --no-rate-limit > /tmp/anvil_fee_$a.log 2>&1 &
    PIDS[$a]=$!
    FORK[$a]="http://127.0.0.1:$port"
    for i in $(seq 1 60); do cast chain-id --rpc-url "${FORK[$a]}" >/dev/null 2>&1 && break; sleep 1; done
    cast rpc anvil_setBalance "$OWNER" 0x56BC75E2D63100000 --rpc-url "${FORK[$a]}" >/dev/null 2>&1
    out=$(cast send --rpc-url "${FORK[$a]}" --unlocked --from "$OWNER" "$FACTORY" "setRaceFee(uint256)" "${WANT[$a]}" 2>&1)
  fi
  if echo "$out" | grep -qE "^status +1"; then say "- ${NAME[$a]}: set \`$(echo "$out" | awk '/^transactionHash/{print $2}')\`"
  else say "- ${NAME[$a]}: **failed**"; say '```'; echo "$out" | tail -8 >> "$REPORT"; say '```'; fail "${NAME[$a]}: setRaceFee failed"; fi
done

say ""; say "Read back:"
bad=0
for a in $CHAINS; do
  for t in 1 2 3 4 5; do v=$(c call "$FACTORY" "raceFee()(uint256)" --rpc-url "${FORK[$a]}"); [ "$v" = "${WANT[$a]}" ] && break; sleep 3; done
  [ "$v" = "${WANT[$a]}" ] && say "- ${NAME[$a]}: $v: ok" || { bad=1; say "- ${NAME[$a]}: **$v**, wanted ${WANT[$a]}"; }
done
say ""
[ $bad = 0 ] && say "**ALL OK ($MODE).**" || { say "**SOMETHING DIDN'T MATCH.**"; exit 1; }
