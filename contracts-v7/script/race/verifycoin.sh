#!/usr/bin/env bash
# Verifies a race coin's source code (LaunchCoin) on the block explorers of the chains it lives
# on, so GMGN, DexScreener and others show "Contract verified". Every coin has the same code,
# so explorers match later coins to it ("similar match") once one is verified per chain.
#   Base, BNB Chain: Etherscan (one key for both: ETHERSCAN_API_KEY)
#   Robinhood Chain: Blockscout (no key)
#   Arc:             its explorer's Blockscout-style API (no key), tried; reported if refused
# COIN: the coin address (the same on every chain). FACTORY: the factory that made it.
# Reads the constructor arguments from the coin itself; sends nothing.

set -uo pipefail
REPORT="${REPORT:-/dev/stdout}"
COIN="${COIN:?COIN=0x...}"
FACTORY="${FACTORY:-0x1Fe532901FE7c66251E55606021b4F2A7e12ABaa}"
declare -A RPC NAME
RPC[8453]="${RPC_8453:-https://mainnet.base.org}";               NAME[8453]="Base"
RPC[56]="${RPC_56:-https://bsc-dataseed.bnbchain.org}";           NAME[56]="BNB"
RPC[4663]="${RPC_4663:-https://rpc.mainnet.chain.robinhood.com}"; NAME[4663]="Robinhood"
RPC[5042]="${RPC_5042:-https://rpc.mainnet.arc.io}";              NAME[5042]="Arc"

say() { echo "$*" >> "$REPORT"; }
c() { local out; for i in 1 2 3 4 5; do out=$(cast "$@" 2>/dev/null) && { echo "$out"; return 0; }; sleep 3; done; echo "ERR"; }
first() { echo "$1" | awk '{print $1}'; }

cd "$(dirname "$0")/../.." || exit 1
# the verifier needs this contract built first (its cache knows the compiler profile)
forge build src/omni/LaunchCoin.sol >/dev/null 2>&1 || forge build src/omni/LaunchCoin.sol 2>&1 | tail -5
say "## Verify coin \`$COIN\`"
say ""
ok_any=0
for a in 8453 56 4663 5042; do
  code=$(c code "$COIN" --rpc-url "${RPC[$a]}")
  if [ "$code" = "ERR" ] || [ "$code" = "0x" ]; then say "- ${NAME[$a]}: no coin here, skipped"; continue; fi
  name=$(c call "$COIN" "name()(string)" --rpc-url "${RPC[$a]}")
  sym=$(c call "$COIN" "symbol()(string)" --rpc-url "${RPC[$a]}")
  ep=$(first "$(c call "$COIN" "endpoint()(address)" --rpc-url "${RPC[$a]}")")
  fee=$(first "$(c call "$COIN" "moveFeeBps()(uint16)" --rpc-url "${RPC[$a]}")")
  tre=$(first "$(c call "$COIN" "treasury()(address)" --rpc-url "${RPC[$a]}")")
  cre=$(first "$(c call "$COIN" "creator()(address)" --rpc-url "${RPC[$a]}")")
  for v in "$name" "$sym" "$ep" "$fee" "$tre" "$cre"; do [ "$v" = "ERR" ] && { say "- ${NAME[$a]}: can't read the coin, skipped"; continue 2; }; done
  # name/symbol come back quoted
  name=${name#\"}; name=${name%\"}; sym=${sym#\"}; sym=${sym%\"}
  args=$(cast abi-encode "constructor(string,string,address,uint16,address,address,uint256,address)" "$name" "$sym" "$ep" "$fee" "$tre" "$cre" 0 "$FACTORY")
  case $a in
    8453|56) flags=(--chain "$a" --verifier etherscan --etherscan-api-key "${ETHERSCAN_API_KEY:-}");;
    4663) flags=(--chain "$a" --verifier blockscout --verifier-url "https://robinhoodchain.blockscout.com/api/");;
    5042) flags=(--chain "$a" --verifier blockscout --verifier-url "${ARC_VERIFIER_URL:-https://explorer.arc.io/api/}");;
  esac
  if [ "$a" = "8453" ] || [ "$a" = "56" ]; then [ -n "${ETHERSCAN_API_KEY:-}" ] || { say "- ${NAME[$a]}: no ETHERSCAN_API_KEY, skipped"; continue; }; fi
  out=$(forge verify-contract "$COIN" src/omni/LaunchCoin.sol:LaunchCoin "${flags[@]}" --constructor-args "$args" --rpc-url "${RPC[$a]}" --watch 2>&1)
  if echo "$out" | grep -qiE "Pass - Verified|successfully verified|already verified|Contract source code already verified"; then
    say "- ${NAME[$a]}: **verified** ✅"; ok_any=1
  else
    say "- ${NAME[$a]}: not verified"; say '```'; echo "$out" | tail -12 >> "$REPORT"; say '```'
  fi
done
say ""
[ $ok_any = 1 ] && say "Done." || { say "**Nothing was verified.**"; exit 1; }
