# sasa v7: the five-minute race (contracts)

A coin opens at once on every chain its creator picks, each with an instant Uniswap v4 pool
(listed on DEX screeners from the first trade). After five minutes the chain whose pool holds
the most dollars wins: the losing pools hand their dollars over (once) and close, the dollars
cross to the winner and deepen its pool (dollars only: no coin is ever minted for it), and
holders' coins on losing chains move to the winner automatically (v6 coin). Then the winning
pool's liquidity is locked forever.


## Layout
- `src/race/`: the new v7 contracts
  - `RaceLaunchHook`: pool hook (launch fee 30% → 2% over 5 min, builder-only pool creation, closed pools)
  - `RaceBuilder`: opens pools, first buy, race report, losing-chain hand-over, winning-chain deepening, fees 70/30, buyback
  - `RaceSeat`: per-coin handle that lets the reviewed v6 hub drive a v7 pool
  - `RaceFactory`: launch (v6 coin with CREATE3 at the same address on every chain, seat, pool, first buy)
- `src/omni/`, `src/usd/`: v6 contracts used **unchanged** (hub, coin, consolidator, deployers,
  USD pool router). CI checks they are byte-identical to `contracts/src/omni` and `contracts/src/usd`.
- `test/RaceFlow.sol`: two-chain race flows (local Uniswap v4, mock LayerZero, mock dollar bridge),
  both token orders, fuzzed supply and dollar conservation.
- `test/fork/RaceFork.t.sol`: the same flows on the real Uniswap v4 of Base and Robinhood Chain,
  plus a real-dollar run (Base USDC, Robinhood USDG).

## Run
Libraries are fetched by the `race-v7` workflow (forge-std v1.9.6, OpenZeppelin v5.1.0,
v4-periphery @9969eec, LayerZero from `contracts/lib/layerzero`).

    forge test --no-match-path "test/fork/*"
    forge test --match-path "test/fork/*" --fork-url base --threads 1
    forge test --match-path "test/fork/*" --fork-url robinhood

Nothing here is deployed; v6 and the live site are untouched.
