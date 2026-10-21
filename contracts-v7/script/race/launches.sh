#!/usr/bin/env bash
# Opens or closes new race launches on all four chains (RaceFactory.setLaunchesOpen), then reads
# it back. OPEN=true|false. Needs PRIVATE_KEY (the factory owner). Coins already launched,
# trading and the races in progress are not affected.
set -uo pipefail
OPEN="${OPEN:?OPEN=true or false}"
REPORT="${REPORT:-/dev/stdout}"
# the v7 factory unless FACTORY names another set's (v8: 0x1Fe532901FE7c66251E55606021b4F2A7e12ABaa)
FACTORY="${FACTORY:-0x88e21D24C35034f80E854efBD5ACD16507a9169B}"
declare -A RPC NAME
RPC[8453]="${RPC_8453:-https://mainnet.base.org}";               NAME[8453]="Base"
RPC[56]="${RPC_56:-https://bsc-dataseed.bnbchain.org}";           NAME[56]="BNB"
RPC[4663]="${RPC_4663:-https://rpc.mainnet.chain.robinhood.com}"; NAME[4663]="Robinhood"
RPC[5042]="${RPC_5042:-https://rpc.mainnet.arc.io}";              NAME[5042]="Arc"
say() { echo "$*" >> "$REPORT"; }
c() { local out; for i in 1 2 3 4 5; do out=$(cast "$@" 2>/dev/null) && { echo "$out"; return 0; }; sleep 3; done; echo "ERR"; }
[ "$OPEN" = "true" ] || [ "$OPEN" = "false" ] || { say "OPEN must be true or false"; exit 1; }
me=$(cast wallet address --private-key "$PRIVATE_KEY" | tr 'A-F' 'a-f')
say "## Launches: $([ "$OPEN" = true ] && echo open || echo closed)"
bad=0
for a in 8453 56 4663 5042; do
  owner=$(c call $FACTORY "owner()(address)" --rpc-url "${RPC[$a]}" | tr 'A-F' 'a-f')
  [ "$owner" = "$me" ] || { say "- ${NAME[$a]}: the key isn't the factory owner ($owner); skipped"; bad=1; continue; }
  now=$(c call $FACTORY "launchesOpen()(bool)" --rpc-url "${RPC[$a]}")
  if [ "$now" = "$OPEN" ]; then say "- ${NAME[$a]}: already $([ "$OPEN" = true ] && echo open || echo closed)"; continue; fi
  out=$(cast send --rpc-url "${RPC[$a]}" --private-key "$PRIVATE_KEY" $FACTORY "setLaunchesOpen(bool)" "$OPEN" 2>&1)
  if echo "$out" | grep -qE "^status +1"; then say "- ${NAME[$a]}: done \`$(echo "$out" | awk '/^transactionHash/{print $2}')\`"; else say "- ${NAME[$a]}: **failed**"; say '```'; echo "$out" | tail -8 >> "$REPORT"; say '```'; bad=1; fi
done
say ""; say "Read back:"
for a in 8453 56 4663 5042; do
  for t in 1 2 3 4 5; do v=$(c call $FACTORY "launchesOpen()(bool)" --rpc-url "${RPC[$a]}"); [ "$v" = "$OPEN" ] && break; sleep 3; done
  [ "$v" = "$OPEN" ] && say "- ${NAME[$a]}: launchesOpen = $v: ok" || { say "- ${NAME[$a]}: launchesOpen = $v **(wanted $OPEN)**"; bad=1; }
done
[ $bad = 0 ] && say "" && say "**ALL OK.**" || { say ""; say "**NOT ALL OK (see above).**"; exit 1; }
