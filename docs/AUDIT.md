# sasa v6: smart contract audit brief

sasa is a meme coin launchpad. A coin is launched on several EVM chains at once
(Robinhood Chain and Base at mainnet) with **the same token address on every chain**.
Each chain runs its own bonding curve priced in a dollar stablecoin; buys on all chains
count toward one shared graduation target. When the target is reached, the chain that
raised the most wins: the other chains' money is bridged to it, a Uniswap v4 pool is
opened there with liquidity locked forever, and holders on the losing chains have their
coins moved (burn and mint, same address) to the winning chain.

- Commit under review: see `COMMIT` (the package was cut from that commit)
- Solidity 0.8.26, Foundry, `via_ir = true`, optimizer 200 runs, EVM `cancun`
- Mainnet target: Robinhood Chain (chain id 4663, LayerZero eid 30416) and Base (8453, eid 30184)
- Contact: the sasa team (see the message that came with this package)

## 1. Scope

| File | nSLOC | Role |
|---|---:|---|
| `src/omni/OmniFactory.sol` | 268 | Launches a coin and its curve on this chain (CREATE3: same coin address everywhere), wires the coin's LayerZero routes, beta money cap, pause |
| `src/omni/OmniHub.sol` | 266 | Cross-chain race: freeze, report, decide (coordinator chain), settle or reopen. Single-chain coins are decided inside `freeze` |
| `src/omni/UsdCurveV6.sol` | 261 | Bonding curve per chain (virtual reserves), 1% fee (creator share 30%), freeze / settle hooks for the hub |
| `src/omni/MigratorV6.sol` + `MigratorV6Core.sol` | 385 | Receives the money on the winning chain, opens the locked Uniswap v4 pool at the graduation price, 2% graduation fee, buyback mode, pool fee collection |
| `src/omni/LaunchCoin.sol` | 167 | The coin: fixed cap, LayerZero OFT moves only after graduation and only to the winning chain, optional creator lock |
| `src/omni/ConsolidatorV6.sol` | 74 | On a losing chain: holds its money after settlement and forwards it to the winner through the bridge |
| `src/omni/AcrossUsdBridge.sol` | 141 | Mainnet money route (Across): consolidator -> Across -> twin bridge on the winner -> migrator |
| `src/omni/OmniOrders.sol` | 152 | Take profit / stop loss / buy-the-dip orders executed by anyone within the owner's bounds |
| `src/omni/SasaBoost.sol` | 51 | Paid placement: payment straight to the treasury, records an end time per coin |
| `src/omni/OmniDeployers.sol`, `src/omni/Create3.sol` | ~100 | Coin / curve deployers used by the factory |
| `src/usd/UsdPoolRouter.sol` | 109 | Buy / sell in graduated pools with slippage and deadline |
| `src/usd/UsdFeeSplitter.sol` | 60 | sasa's fee share: 30% to the rewards wallet, 70% to the treasury |
| `src/curve/NeuronGraduationHook.sol` | 79 | v4 hook: only the migrator may initialize a sasa pool (nobody can front-run the pool at a wrong price) |

Total about 2,100 nSLOC.

**Out of scope:** everything else in `src/` (earlier versions kept for history: `v2`, `v3`,
`neuron`, older `curve` and `usd` contracts other than the files above), `src/omni/TestUsdOft.sol`
and `src/omni/OftUsdBridge.sol` (testnet only), deployment scripts (included for context),
the web app and the off-chain services.

## 2. How it works

### Launch (`OmniFactory.launch`)
- One call per chain, same `launchKey` and the same sorted list of LayerZero endpoint ids on
  every chain. Coin id = `keccak256(creator, launchKey)`; the coin address comes from CREATE3
  and is identical on every chain (the factory itself is deployed at the same address on
  every chain from a dedicated deployer key at nonce 0/1).
- The factory deploys the coin and the curve, registers the curve with the hub (eids, target),
  sets the coin's peers and DVN routes from `routes`, then sets the coin's LayerZero delegate
  to a dead address (nobody can change a coin's routes afterwards).
- Optional creator first buy in the same transaction; optional creator lock (1 h or 24 h).
- Virtual reserves are split across the chains of a coin: each chain's curve starts with
  `virtualNative / n` and `virtualToken / n`, so the combined price matches a single curve.

### Trading on the curve (`UsdCurveV6`)
- Constant product on virtual + real reserves, in the chain's dollar (6 decimals).
- 1% fee per trade: 30% creator share (paid to the creator, or used for buyback if the
  creator chose buyback mode), 70% protocol (to the fee splitter).
- `factory.noteNativeIn/Out` track the money held by all curves on this chain for the beta
  cap; buys can be paused by the guardian or owner; sells are never paused.

### The race (`OmniHub`)
1. When the total across chains reaches the target, the keeper calls `freeze` on every chain.
   Each curve stops trading and reports (money, sold) to the coordinator hub (Base) over
   LayerZero.
2. When every chain has reported, anyone calls `finalize` on the coordinator. If the total
   reached the target it graduates: the richest chain wins (ties: lowest eid), and the pool
   size is computed from the combined curve (`poolTokens = R / P_g`). Otherwise all chains
   reopen.
3. The decision is sent to every chain; each curve settles: the winner sends its money and
   pool coins to the migrator, losers send their money to the consolidator. The coin's
   bridge opens with the winner as home.
- A coin launched on a single chain is decided inside its own `freeze` (no messages).
- If the keeper is silent for `KEEPER_GRACE`, anyone may freeze (rate limited).

### Consolidation (`ConsolidatorV6` -> `AcrossUsdBridge` -> `MigratorV6Core.receiveConsolidated`)
- Anyone calls `forward` on a losing chain; the bridge deposits into Across with the twin
  bridge on the winning chain as recipient and `abi.encode(coin, buyback)` as message.
- Across's fee is taken from the amount (output = input * (1 - feeBps), feeBps <= 0.5%).
- On fill, Across's SpokePool calls `handleV3AcrossMessage`; the money goes to the migrator.
- Unfilled deposits are refunded by Across to the bridge; only the owner can `resend` them,
  once, to the same coin and destination.

### Graduation pool (`MigratorV6.open`)
- Ready when >= 99% of the expected money arrived, or 30 minutes after settlement.
- 2% of the money goes to the treasury and the same share of pool coins is burned, so the
  pool opens at the graduation price `P_g`. Coins for money that never arrived are burned.
- If more money than expected arrives (a gift, or a bridge paying more), the pool keeps all
  the pool coins and all the money, so it opens slightly **above** P_g (only good for holders).
- Full-range position in a 1% Uniswap v4 pool with `NeuronGraduationHook`; the position NFT
  stays in the migrator forever (no function can remove liquidity).
- Pool fees: `collectFees` splits the coin-side and dollar-side fees between creator (30%)
  and protocol (70%), or funds buyback in buyback mode.
- Money arriving after the pool opened buys the coin back and burns it.

### Moving holders to the winning chain (`LaunchCoin`)
- After graduation, sasa's keeper moves **plain accounts'** coins (no code, or an EIP-7702
  delegated EOA) from a losing chain to the same address on the winning chain, minus a 0.1%
  fee. For the first 24 hours only the keeper may do this for others; each holder may move
  their own coins any time (`moveSelf`); after 24 hours anyone may call `moveBatch`.
  Contract wallets can only move their own coins with OFT `send`.

### Orders (`OmniOrders`)
- Users pre-approve; anyone may execute an order, but the trade must return an amount within
  the owner's `[minOut, maxOut]`. Orders refuse to run while a coin is frozen, and on a chain
  that lost the race.

## 3. Roles and permissions

| Role | Who | Can | Cannot |
|---|---|---|---|
| Owner (factory, hub, bridge) | sasa admin wallet, moving to a 2/3 Safe | Set routes / config **for future launches** (fee <= 10%, move fee <= 0.5%, at least `minDvns` verifiers), open/close launches, set guardian, set the beta cap, unpause buys, set hub keeper/peers, Across fee within 0.5%, resend refunded Across deposits | Take users' or coins' money; change a launched coin's routes, fee or supply; remove pool liquidity; pause sells; renounce (disabled) |
| Guardian | Hot wallet | `pauseBuys` | Unpause, anything else |
| Keeper | Bot wallet (set on the hub by the owner) | `freeze` (no rate limit), `forward`, `open`, move holders during the first 24 h after graduation | Choose the winner (pure math on reports), redirect money |
| Splitter owner | sasa admin | Change treasury / rewards addresses and shares | Take funds already distributed |
| Boost owner | sasa admin | Change plans and treasury | Anything about coins or trading |
| Anyone | | Trade, finalize, forward, open, collect fees, execute orders within bounds, move plain accounts' coins to the winner (same address) | |

## 4. Invariants we rely on

1. A coin's total supply across all chains never exceeds 1,000,000,000 (minted only by its
   curve / migrator, or by an OFT arrival matched by a burn on another chain).
2. Before graduation a coin cannot leave its chain; after graduation it can only go to the
   winning chain, to the same address.
3. Each curve always holds at least what it owes: real reserves plus accrued fees equal its
   dollar balance; sells can always be paid while trading.
4. Graduation is decided only from the reports of every chain of the coin for the same round
   and the same launch parameters; stale or foreign reports are ignored.
5. Money of a graduated coin can only end up in that coin's pool (migrator), as fees to the
   creator / protocol / treasury as configured, or burned via buyback; never anywhere else.
6. Locked pool liquidity can never be removed.
7. Only the migrator can initialize a pool with the sasa hook.
8. An order never fills outside its owner's `[minOut, maxOut]`.
9. Fees can never exceed their caps (curve 10% for future launches, coin move 0.5%,
   Across 0.5%, graduation 2% fixed).

## 5. External dependencies and trust assumptions

- **LayerZero v2**: hub messages and coin moves. Mainnet routes use 2 required DVNs
  (LayerZero Labs + one more), 3 confirmations. A compromised DVN set could forge decisions;
  an owner-controlled hub could be pointed at a wrong peer (owner is trusted for this).
- **Across**: SpokePool on both chains. Fill risk only delays (refund + resend); delivered
  money can only reach the migrator.
- **Uniswap v4**: PoolManager, PositionManager, Permit2 (official deployments on both chains).
- **Dollars**: Circle USDC on Base, Paxos USDG on Robinhood Chain (both 6 decimals, upgradeable,
  can blacklist). A blacklist on a sasa contract would freeze that contract's money.
- **EIP-7702**: users' email wallets are EOAs delegated to a smart account; they count as
  plain accounts for coin moves.

## 6. Known issues and accepted risks

- During a race, prices differ slightly between chains (each chain has its own curve);
  arbitrage across chains is expected.
- Trading pauses between `freeze` and settlement (a few LayerZero messages, about a minute).
- The keeper is trusted for liveness, not for correctness; if it stops, anyone can freeze
  after the grace period.
- Beta cap: total money held by curves per chain is capped (initially $5,000) until audit.
- Creator first-buy has no slippage limit by design (same transaction as the curve creation).

## 7. Build and test

```
foundry: 1.x, solc 0.8.26 (downloaded by forge)
forge build
forge test --match-path "test/omni/*" -vv          # v6 unit tests (incl. Across, Boost, single-chain)
forge test --match-path "test/fork/NeuronOmniV6*" --fork-url robinhood -vv   # real Uniswap v4 + USDG
forge test --match-path "test/fork/NeuronOmniV6*" --fork-url base -vv        # real Uniswap v4 + USDC
forge test --match-path "test/fork/AcrossBridge*" -vv                        # real Across SpokePools
forge test --match-path "test/fork/DollarSlots*" -vv                          # storage slots of USDC/USDG
```
RPC endpoints for the fork tests are in `foundry.toml` (`robinhood`, `base`).

Mainnet parameters (from `script/omni`): virtual dollars 4,500 and virtual tokens
1,073,000,000 per coin (split across its chains), target $10,000, curve fee 1% (creator 30%),
coin move fee 0.1%, at least 2 DVNs, coordinator Base.

## 8. Round 1 findings and responses

| ID | Finding | Status | Change |
|---|---|---|---|
| M-1 | `moveBatch` lets anyone move a plain account's coins to the winner | **Fixed (round 2)** | For the first 24 hours after graduation (`PUBLIC_MOVE_AFTER`) only sasa's keeper (read from the coin's curve -> hub, no admin on the coin) may call `moveBatch`; each holder can move their own coins at any time with the new `moveSelf`; after 24 hours anyone may call `moveBatch`, so coins never stay stuck if the keeper stops. Moves still go only to the holder's own address on the winning chain and never touch contract wallets. Test: `test_moveBatch_keeperOnlyFirstDay_thenAnyone_moveSelfAnytime`. |
| M-2 | Across refund smaller than the deposit would block `resend` | **Fixed** | `AcrossUsdBridge.resendAmount(id, amount, feeBps)`: owner only, once per deposit, amount <= the original and <= the bridge's balance, same coin and destination. Test: `test_resendAmount_partialRefund_sameCoinSameChain`. |
| L-1 | Rounding dust (or donations) left in a settled curve | **Fixed** | `UsdCurveV6.settle` adds any balance above what the curve owes (money + creator + protocol fees) to `protocolFees`, so the curve always empties. Test: `test_settle_leftoverDollarsGoToProtocol_nothingStuck`. |
| L-2 | Extra money at `open` raises the opening price above P_g | **Documented** | Only happens when more than the expected money arrives (a gift); the pool then opens slightly above P_g, which only benefits holders. |
| L-3 | `maxOut` checked after the trade in `OmniOrders` | No change | The revert undoes the whole trade, as noted. |
| L-4 | Public freeze could be repeated hourly when the keeper is silent | **Accepted** | Only possible when the keeper has been silent for the grace period; a freeze below target reopens with no loss. Keeper monitoring alerts us before that. |
| Info | Missing events on admin setters | **Fixed** | `GuardianSet`, `NativeCapSet`, `LaunchesOpenSet` (factory), `FactorySet`, `KeeperSet` (hub). `AcrossUsdBridge.setFeeBps` already emits `FeeSet`. |
| Info | `BadFee` used for a bad lock length | No change | Cosmetic; kept to avoid touching the coin's bytecode. |

All v6 unit tests pass after the changes (71 tests). `round1-fixes.diff` shows the round 1 changes since commit `bdb6316`; `round2-fixes.diff` shows the M-1 change on top of them.
