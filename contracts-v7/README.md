# sasa v7: the five-minute race (contracts)

A coin opens at once on every chain its creator picks, each with an instant pool in the
chain's own money: coin/ETH on Uniswap v4 (Base, Robinhood Chain), coin/BNB on PancakeSwap
Infinity (BNB Chain), coin/USDC on Uniswap v4 (Arc). Listed on DEX screeners from the first
trade. Users still only see dollars: the trade routers do USDC <-> ETH/BNB <-> coin in one call,
and the race is judged in dollars with Chainlink prices. After five minutes the chain whose pool holds
the most dollars wins: the losing pools hand their dollars over (once) and close, the dollars
cross to the winner and deepen its pool (dollars only: no coin is ever minted for it), and
holders' coins on losing chains move to the winner automatically (v6 coin). Then the winning
pool's liquidity is locked forever.

The race result is the money in each pool when its five minutes end. The pool hook makes the
builder write it down before the first swap after that moment (and the report writes it if
nothing traded since), so trades after the race can't change who wins. Arriving dollars are never
placed above the coin's price at the race end, and buybacks are run by sasa's keeper only, with
a minimum, so neither can be squeezed by pushing the price around them.


## Layout
- `src/race/`: the new v7 contracts
  - `RaceLaunchHook`: pool hook (launch fee 10% → 2% over 2 min, builder-only pool creation, closed pools, race-end record)
  - `RaceBuilder`: USDC pools (Arc): opens pools, first buy, race report, losing-chain hand-over, winning-chain deepening, fees 70/30, buyback
  - `RaceBuilderEth` + `RaceTradeEth`: the same for coin/ETH pools on Uniswap v4 (Base, Robinhood Chain), Chainlink ETH/USD
  - `RaceBuilderPcs` + `RaceLaunchHookPcs` + `RaceTradePcs`: the same for coin/BNB pools on PancakeSwap Infinity (BNB Chain), Chainlink BNB/USD
  - `testnet/TestnetSupport.sol`: testnet-only test dollar (OFT + faucet), test price feed, test dollar pool
  - `RaceSeat`: per-coin handle that lets the reviewed v6 hub drive a v7 pool
  - `RaceFactory`: launch (v6 coin with CREATE3 at the same address on every chain, seat, pool, first buy)
- `src/omni/`, `src/usd/`: v6 contracts used **unchanged** (hub, coin, consolidator, deployers,
  USD pool router). CI checks they are byte-identical to `contracts/src/omni` and `contracts/src/usd`.
- `test/RaceFlow.sol`: two-chain race flows (local Uniswap v4, mock LayerZero, mock dollar bridge),
  both token orders, fuzzed supply and dollar conservation.
- `test/RaceEthFlow.t.sol`, `test/RacePcsFlow.t.sol`: the ETH and BNB pair flows (local Uniswap v4 / PancakeSwap Infinity).
- `test/DeployRace.t.sol`: the deploy script, every kind, as it runs on a testnet.
- `test/fork/`: the same flows on the real Uniswap v4 of Base, Robinhood Chain and Arc, the
  real PancakeSwap Infinity of BNB Chain, real dollars and real Chainlink feeds.

## Run
Libraries are fetched by the `race-v7` workflow (forge-std v1.9.6, OpenZeppelin v5.1.0,
v4-periphery @9969eec, LayerZero from `contracts/lib/layerzero`).

    forge test --no-match-path "test/fork/*" --no-match-contract DeployRaceTest
    forge test --match-contract DeployRaceTest --threads 1
    forge test --match-path "test/fork/*" --fork-url base --threads 1
    forge test --match-path "test/fork/*" --fork-url robinhood
    forge test --match-path "test/fork/RacePcsFork.t.sol" --fork-url bsc --threads 1
    forge test --match-path "test/fork/RaceFork.t.sol" --fork-url arc --threads 1

Nothing here is deployed; v6 and the live site are untouched.
