#!/usr/bin/env bash
# Moves sasa's race (hub + new coins) off the one-DVN LayerZero setup onto four DVNs.
#
# Why: with "LayerZero Labs only", LayerZero Labs' DVN never verified the race reports (6 stuck
# messages, Oct 18 2026). Every working app on these chains uses several DVNs together. This sets,
# on Base, BNB Chain, Robinhood Chain and Arc, for every other chain:
#   - the race hub's send + receive settings: 4 required DVNs (LayerZero Labs, Nethermind,
#     Horizen, Canary), the same on both ends, confirmations = the larger of the two chains';
#   - the factory's route (what every NEW coin gets, for good) to the same settings;
#   - launches closed (they reopen only after an end-to-end test of a new coin).
# On Base it also skips the hub's stuck messages (the old reports; their races stay unfinished:
# those coins keep trading on every chain, see keeper).
#
# MODE=dry-run: each chain is copied (anvil --fork-url) and every step runs there as the real
#   owner, then everything is read back and checked. Nothing is sent to a real chain.
# MODE=apply:   the same steps, sent for real with PRIVATE_KEY, then read back and checked.
#
# Needs: foundry (cast, anvil), jq, curl. Writes a report to $REPORT (default: stdout).

set -uo pipefail
MODE="${MODE:-dry-run}"
REPORT="${REPORT:-/dev/stdout}"
HUB=0x173b228d343E174D2671a61C294D3AF06946DEBf
FACTORY=0x88e21D24C35034f80E854efBD5ACD16507a9169B
CHAINS="8453 56 4663 5042"
DVN_NAMES=("LayerZero Labs" "Nethermind" "Horizen" "Canary")
declare -A RPC NAME EID EP SEND RECV EXEC DVNS CONF FORK PIDS
RPC[8453]="${RPC_8453:-https://mainnet.base.org}";                NAME[8453]="Base";      CONF[8453]=10
RPC[56]="${RPC_56:-https://bsc-rpc.publicnode.com}";               NAME[56]="BNB";         CONF[56]=20
RPC[4663]="${RPC_4663:-https://rpc.mainnet.chain.robinhood.com}";  NAME[4663]="Robinhood"; CONF[4663]=5
RPC[5042]="${RPC_5042:-https://rpc.mainnet.arc.io}";               NAME[5042]="Arc";       CONF[5042]=5
HUB32=$(echo "0x000000000000000000000000${HUB#0x}" | tr 'A-F' 'a-f')

say() { echo "$*" >> "$REPORT"; }
fail() { say ""; say "**STOPPED: $***"; cleanup; exit 1; }
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done; }
trap cleanup EXIT
# reads retry on flaky public nodes
c() { local out; for i in 1 2 3 4 5; do out=$(cast "$@" 2>/dev/null) && { echo "$out"; return 0; }; sleep 3; done; echo "ERR"; }
lc() { echo "$1" | tr 'A-F' 'a-f'; }
pair_conf() { local a=${CONF[$1]} b=${CONF[$2]}; [ "$a" -gt "$b" ] && echo "$a" || echo "$b"; }

# ------------------------------------------------------------------ LayerZero's addresses
if [ -n "${LZ_METADATA:-}" ]; then cp "$LZ_METADATA" /tmp/lzmeta.json; else
  curl -fsSL https://metadata.layerzero-api.com/v1/metadata/deployments -o /tmp/lzmeta.json || fail "LayerZero metadata unreachable"; fi
for id in $CHAINS; do
  E=$(jq -c --argjson id "$id" '[to_entries[] | select(.value.chainDetails.nativeChainId == $id and (.key|test("testnet|sepolia")|not))][0].value' /tmp/lzmeta.json)
  [ "$E" = "null" ] && fail "LayerZero has no entry for chain $id"
  V2=$(echo "$E" | jq -c '[.deployments[] | select(.version == 2)][0]')
  EID[$id]=$(echo "$V2" | jq -r '.eid'); EP[$id]=$(echo "$V2" | jq -r '.endpointV2.address')
  SEND[$id]=$(echo "$V2" | jq -r '.sendUln302.address'); RECV[$id]=$(echo "$V2" | jq -r '.receiveUln302.address')
  EXEC[$id]=$(echo "$V2" | jq -r '.executor.address')
  list=()
  for n in "${DVN_NAMES[@]}"; do
    hits=$(echo "$E" | jq -r --arg n "$n" '[.dvns // {} | to_entries[] | select(.value.canonicalName == $n and (.value.deprecated|not) and (.value.lzReadCompatible|not)) | .key] | .[]')
    count=$(echo "$hits" | grep -c . || true)
    [ "$count" = "1" ] || fail "${NAME[$id]}: expected exactly one live '$n' DVN, found $count"
    list+=("$(lc "$hits")")
  done
  # sorted ascending, as LayerZero requires
  DVNS[$id]=$(printf '%s\n' "${list[@]}" | sort | paste -sd, -)
done

say "## LayerZero fix ($MODE)"
say ""
say "| chain | eid | endpoint | DVNs (sorted) |"; say "|---|---|---|---|"
for id in $CHAINS; do say "| ${NAME[$id]} | ${EID[$id]} | \`${EP[$id]}\` | \`${DVNS[$id]}\` |"; done

# ------------------------------------------------------------------ checks before anything
say ""; say "### Checks"
for a in $CHAINS; do
  chainid=$(c chain-id --rpc-url "${RPC[$a]}")
  [ "$chainid" = "$a" ] || fail "${NAME[$a]} RPC answers chain $chainid"
  for b in $CHAINS; do
    [ "$a" = "$b" ] && continue
    for d in ${DVNS[$a]//,/ }; do
      raw=$(c call "$d" "dstConfig(uint32)" "${EID[$b]}" --rpc-url "${RPC[$a]}")
      [ "$raw" = "ERR" ] && fail "${NAME[$a]}: can't read DVN $d"
      [ "${raw:2:64}" = "0000000000000000000000000000000000000000000000000000000000000000" ] && fail "${NAME[$a]}: DVN $d doesn't serve ${NAME[$b]}"
    done
  done
done
say "- every chosen DVN serves every other chain: ok"

OWNER=""
for a in $CHAINS; do
  del=$(lc "$(c call "${EP[$a]}" "delegates(address)(address)" $HUB --rpc-url "${RPC[$a]}")")
  fo=$(lc "$(c call $FACTORY "owner()(address)" --rpc-url "${RPC[$a]}")")
  [ "$del" = "err" ] || [ "$fo" = "err" ] && fail "${NAME[$a]}: can't read the owner"
  [ "$del" = "$fo" ] || fail "${NAME[$a]}: hub delegate $del and factory owner $fo differ"
  [ -z "$OWNER" ] && OWNER=$del
  [ "$OWNER" = "$del" ] || fail "owner differs between chains ($OWNER / $del)"
done
say "- hub delegate and factory owner on all four chains: \`$OWNER\`"
for a in $CHAINS; do say "- owner's gas on ${NAME[$a]}: $(c balance "$OWNER" --ether --rpc-url "${RPC[$a]}")"; done
if [ "$MODE" = "apply" ]; then
  [ -n "${PRIVATE_KEY:-}" ] || fail "no PRIVATE_KEY"
  me=$(lc "$(cast wallet address --private-key "$PRIVATE_KEY")")
  [ "$me" = "$OWNER" ] || fail "the key is $me, not the owner $OWNER"
  say "- the key is the owner: ok"
fi

# messages still out from each chain's hub to Base (the stuck reports)
declare -A OUT IN
for a in 56 4663 5042; do
  OUT[$a]=$(c call "${EP[$a]}" "outboundNonce(address,uint32,bytes32)(uint64)" $HUB "${EID[8453]}" "$HUB32" --rpc-url "${RPC[$a]}" | awk '{print $1}')
  IN[$a]=$(c call "${EP[8453]}" "inboundNonce(address,uint32,bytes32)(uint64)" $HUB "${EID[$a]}" "$HUB32" --rpc-url "${RPC[8453]}" | awk '{print $1}')
  [ "${OUT[$a]}" = "ERR" ] || [ "${IN[$a]}" = "ERR" ] && fail "can't read the nonces for ${NAME[$a]}"
  say "- ${NAME[$a]} -> Base: sent ${OUT[$a]}, arrived ${IN[$a]}"
  [ "${OUT[$a]}" -le 2 ] || fail "${NAME[$a]} sent ${OUT[$a]} messages to Base; expected at most 2 (only the two stuck races). Look before skipping anything."
done

# ------------------------------------------------------------------ the steps
# where each chain's steps go: a copy (dry run) or the chain itself
port=18600
for a in $CHAINS; do
  if [ "$MODE" = "apply" ]; then
    FORK[$a]="${RPC[$a]}"
  else
    port=$((port + 1))
    anvil --fork-url "${RPC[$a]}" --port $port --auto-impersonate --silent --no-rate-limit > /tmp/anvil_$a.log 2>&1 &
    PIDS[$a]=$!
    FORK[$a]="http://127.0.0.1:$port"
  fi
done
if [ "$MODE" != "apply" ]; then
  for a in $CHAINS; do for i in $(seq 1 60); do cast chain-id --rpc-url "${FORK[$a]}" >/dev/null 2>&1 && break; sleep 1; done; done
fi

send() { # chain, label, to, sig, args...
  local a=$1 label=$2; shift 2
  local out
  if [ "$MODE" = "apply" ]; then
    out=$(cast send --rpc-url "${FORK[$a]}" --private-key "$PRIVATE_KEY" "$@" 2>&1)
  else
    out=$(cast send --rpc-url "${FORK[$a]}" --unlocked --from "$OWNER" "$@" 2>&1)
  fi
  if ! echo "$out" | grep -qE "^status +1"; then
    say "- ${NAME[$a]}: $label **FAILED**"; say '```'; echo "$out" | tail -15 >> "$REPORT"; say '```'
    fail "${NAME[$a]}: $label failed (nothing after it was sent)"
  fi
  local tx; tx=$(echo "$out" | awk '/^transactionHash/{print $2}')
  say "- ${NAME[$a]}: $label ok \`$tx\`"
}
uln_of() { # local chain, remote chain -> abi-encoded UlnConfig
  local conf; conf=$(pair_conf "$1" "$2")
  cast abi-encode "f((uint64,uint8,uint8,uint8,address[],address[]))" "($conf,4,0,0,[${DVNS[$1]}],[])"
}

say ""; say "### Steps"
for a in $CHAINS; do
  execcfg=$(cast abi-encode "f(uint32,address)" 10000 "${EXEC[$a]}")
  for b in $CHAINS; do
    [ "$a" = "$b" ] && continue
    uln=$(uln_of "$a" "$b")
    send "$a" "hub sends to ${NAME[$b]}: 4 DVNs, $(pair_conf "$a" "$b") confirmations" "${EP[$a]}" "setConfig(address,address,(uint32,uint32,bytes)[])" $HUB "${SEND[$a]}" "[(${EID[$b]},1,$execcfg),(${EID[$b]},2,$uln)]"
    send "$a" "hub receives from ${NAME[$b]}: same" "${EP[$a]}" "setConfig(address,address,(uint32,uint32,bytes)[])" $HUB "${RECV[$a]}" "[(${EID[$b]},2,$uln)]"
    send "$a" "new coins' route to ${NAME[$b]}: same" $FACTORY "setRoute(uint32,(address,address,bytes,bytes))" "${EID[$b]}" "(${SEND[$a]},${RECV[$a]},$execcfg,$uln)"
  done
  open=$(c call $FACTORY "launchesOpen()(bool)" --rpc-url "${FORK[$a]}")
  if [ "$open" = "true" ]; then send "$a" "launches closed" $FACTORY "setLaunchesOpen(bool)" false; else say "- ${NAME[$a]}: launches already closed"; fi
done
for a in 56 4663 5042; do
  n=$(( ${IN[$a]} + 1 ))
  while [ "$n" -le "${OUT[$a]}" ]; do
    send 8453 "skip stuck report $n from ${NAME[$a]}" "${EP[8453]}" "skip(address,uint32,bytes32,uint64)" $HUB "${EID[$a]}" "$HUB32" "$n"
    n=$((n + 1))
  done
done

# ------------------------------------------------------------------ read back
say ""; say "### Read back"
bad=0
want_uln() { echo "($(pair_conf "$1" "$2"), 4, 0, 0, [${DVNS[$1]//,/, }], [])"; }
for a in $CHAINS; do
  for b in $CHAINS; do
    [ "$a" = "$b" ] && continue
    w=$(lc "$(want_uln "$a" "$b")")
    s=$(lc "$(c call "${SEND[$a]}" "getUlnConfig(address,uint32)((uint64,uint8,uint8,uint8,address[],address[]))" $HUB "${EID[$b]}" --rpc-url "${FORK[$a]}")")
    r=$(lc "$(c call "${RECV[$a]}" "getUlnConfig(address,uint32)((uint64,uint8,uint8,uint8,address[],address[]))" $HUB "${EID[$b]}" --rpc-url "${FORK[$a]}")")
    rt=$(lc "$(c call $FACTORY "routeOf(uint32)((address,address,bytes,bytes))" "${EID[$b]}" --rpc-url "${FORK[$a]}")")
    u=$(lc "$(uln_of "$a" "$b")")
    ok=1; [ "$s" = "$w" ] || ok=0; [ "$r" = "$w" ] || ok=0; echo "$rt" | grep -q "${u#0x}" || ok=0
    if [ $ok = 1 ]; then say "- ${NAME[$a]} -> ${NAME[$b]}: hub send, hub receive, new-coin route: ok"; else bad=1; say "- ${NAME[$a]} -> ${NAME[$b]}: **MISMATCH** send=\`$s\` receive=\`$r\` want=\`$w\`"; fi
  done
  open=$(c call $FACTORY "launchesOpen()(bool)" --rpc-url "${FORK[$a]}")
  [ "$open" = "false" ] && say "- ${NAME[$a]}: launches closed: ok" || { bad=1; say "- ${NAME[$a]}: launches **still open**"; }
done
for a in 56 4663 5042; do
  lz=$(c call "${EP[8453]}" "lazyInboundNonce(address,uint32,bytes32)(uint64)" $HUB "${EID[$a]}" "$HUB32" --rpc-url "${FORK[8453]}" | awk '{print $1}')
  [ "$lz" = "${OUT[$a]}" ] && say "- Base: stuck reports from ${NAME[$a]} skipped (next expected: $((lz + 1))): ok" || { bad=1; say "- Base: reports from ${NAME[$a]}: lazy nonce $lz, expected ${OUT[$a]}"; }
done
say ""
if [ $bad = 0 ]; then say "**ALL OK ($MODE).**"; else say "**SOMETHING DIDN'T MATCH (see above).**"; exit 1; fi
