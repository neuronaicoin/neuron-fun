# sasa mainnet switch day

Everything below is done one step at a time, together. Contracts first, then the off-chain side.

## Before the day
- Wallets: sasa deployer (key in GitHub secret `MAINNET_DEPLOYER_KEY`), sasa admin, GUARDIAN,
  a new mainnet keeper wallet. Factory wallet `OMNI_FACTORY_KEY` must still be unused on Base and Robinhood.
- Repo variables: `MAINNET_ADMIN`, `MAINNET_GUARDIAN` (and `REWARDS` = sasa rewards wallet).
- ETH: ~$10 on each chain for the deployer, a few dollars on each chain for the keeper.
- Upgrades: Supabase Pro, Alchemy mainnet gas policies (Base + Robinhood) with a monthly cap.
- `.github/workflows/deploy-mainnet.yml` added.

## Contracts (Actions -> deploy-mainnet; dry run first, then broadcast)
1. rewards on base, rewards on robinhood
2. deploy on base, deploy on robinhood
3. wire on base, wire on robinhood
4. orders on base, orders on robinhood
5. handover on base, handover on robinhood (money cap per chain)
6. settings -> copy what it prints

## Off-chain
7. web/lib/mainnet.json <- printed values (+ Alchemy gas policy ids); web/lib/config.ts NETWORK = "mainnet"
8. Railway neuron-fun (indexer): CHAINS <- printed value
9. Railway rewards: CHAINS <- printed value
10. Railway keeper: DEPLOYMENTS, RPC_4663, RPC_8453, PRIVATE_KEY (keeper wallet)
11. Supabase SQL: indexer/boost.sql, then indexer/reset-mainnet.sql
12. Privy: production mode; Alchemy key domain allowlist stays

## First real test (small money)
13. Launch a coin on both chains, buy on both, graduate, pool trades, coins move, cash move (Across), auto order, payout, Boost, deposit (send USDC + another coin), withdraw, other-DEX coin buy/sell.
14. Soft launch, then announce.

## First week
- Move ownership from sasa admin to a 2/3 Safe (step by step).
- Raise the money cap as things run smoothly.
