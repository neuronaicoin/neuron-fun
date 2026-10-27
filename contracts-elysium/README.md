# sasa on Elysium

`SasaV3Launcher` launches a coin in one transaction on any chain with a Uniswap-v3-style DEX
(Elysium first): fixed supply, all of it into a coin/WHYPE pool as one-sided liquidity at the start
market cap, the liquidity position locked in the launcher forever, and the creator's first buy made
straight against the pool. The pool fee (1%) is the trading fee; `collect(coin)` splits it between
sasa's treasury and the creator (30% by default, fixed per coin at launch).

Tests: `forge test` (deploys Uniswap v3 from the official npm artifacts in `v3/`, runs every case
with the coin as token0 and as token1, plus fuzzing).

Deploy: GitHub Actions "Deploy sasa launcher on Elysium" (`.github/workflows/deploy-elysium.yml`).
