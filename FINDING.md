# User Lockout During Oracle Degradation Window While Liquidations Continue on Relaxed Staleness

**Severity:** High  
**Date:** June 2026  
**Researcher:** Tejanadh

## Summary

Jupiter Lend enforces two different oracle staleness thresholds: **600 seconds** for user operations and **7,200 seconds** for liquidations. When a Chainlink Data Streams keeper experiences degradation, a deterministic **~1.8-hour window** opens (601s–7200s) where all user self-rescue operations are blocked but liquidations continue against stale prices.

This creates **asymmetric user harm**: borrowers cannot deposit additional collateral or repay debt to defend their positions, while liquidators can still execute against oracle prices that may no longer reflect market reality.

**Affected programs (mainnet):**

| Program | Address |
|---------|---------|
| Oracle | `jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc` |
| Vaults | `jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi` |

**Affected oracles:** All 4 xStocks/RWA Chainlink Data Streams pairs (nonces 60–63).

---

## Vulnerability Detail

### Root Cause

```rust
// programs/oracle/src/constants.rs
pub const MAX_AGE_OPERATE: u64 = 600;    // 10 minutes
pub const MAX_AGE_LIQUIDATE: u64 = 7200; // 2 hours
```

Vault `operate` calls `get_both_exchange_rate()`, which requires **both** rates to succeed:

```rust
// programs/oracle/src/lib.rs
pub fn get_both_exchange_rate(...) -> Result<(u128, u128)> {
    Ok((
        get_hops_exchange_rate(..., Some(true),)?,   // liquidate — 7200s
        get_hops_exchange_rate(..., Some(false),)?,  // operate  — 600s ← fails first
    ))
}
```

When cache age exceeds 600s, the operate leg fails with `PriceTooOld` (6001), blocking **all** vault operations.

Liquidations call `get_exchange_rate_liquidate()` directly:

```rust
// programs/vaults/src/utils/liquidate.rs
let exchange_rate: u128 = oracle_cpi_accounts.get_exchange_rate_liquidate(nonce)?;
```

This succeeds until cache age exceeds 7200s.

### The Asymmetry

```
TIME SINCE LAST KEEPER REFRESH:
0s───────────600s─────────────────────────7200s──────→
│            │                             │
│  NORMAL    │  DANGER ZONE                │  DEAD
│  Users: ✅  │  Users: ❌ LOCKED OUT       │  All: ❌
│  Liq:   ✅  │  Liq:   ✅ STILL ACTIVE     │  Liq: ❌
```

| Actor | 601s–7200s |
|-------|------------|
| Deposit collateral | ❌ |
| Repay debt | ❌ |
| Withdraw / borrow | ❌ |
| Liquidate at stale price | ✅ |

### What Was Disproven

The read-path staleness bypass (that `get_exchange_rate_operate` skips `MAX_AGE_OPERATE` on cached Chainlink DS prices) was **disproven**. All 4 oracle pairs reject at 631s with `PriceTooOld`. The finding is about **asymmetric threshold application**, not missing checks.

---

## Impact

### Scenario 1: Unfair Liquidation (primary)

1. Keeper stops refreshing
2. Real collateral price **rises** after last cache update
3. After 600s, all user operations freeze
4. Stale oracle understates collateral → position looks underwater
5. Liquidator executes at stale-low price
6. User loses collateral + penalty on a position that may be healthy at spot
7. User **cannot** deposit or repay to prevent liquidation

**Example:** $500K position, 5% liquidation penalty → **$25K direct user loss** per unfair liquidation.

### Scenario 2: Bad Debt (secondary)

1. Keeper stops refreshing
2. Real price **falls** sharply
3. Stale oracle overstates collateral → underwater positions appear healthy
4. Liquidation delayed up to 7200s → protocol may absorb bad debt

---

## Proof of Concept

Executed on Surfpool mainnet fork. Scripts in `poc/scripts/`.

### asymmetry_poc.mjs

| Cache age | `get_exchange_rate_operate` | `get_exchange_rate_liquidate` |
|-----------|----------------------------|-------------------------------|
| 30s | ✅ OK | ✅ OK |
| 631s | ❌ PriceTooOld (6001) | ✅ OK |

### both_rates_poc.mjs

| State | `get_both_exchange_rate` |
|-------|--------------------------|
| Fresh (30s) | ✅ PASS |
| Stale (+601s) | ❌ PriceTooOld |

Confirms all vault `operate` paths blocked when operate rate fails.

### Reproduction

```bash
cd poc && npm install
./start_surfpool.sh                    # terminal 1
LOCAL_RPC=http://127.0.0.1:8899 npm run test:asymmetry   # terminal 2
LOCAL_RPC=http://127.0.0.1:8899 npm run test:both-rates
```

---

## Recommended Fix

**Option A (recommended):** Allow `deposit` and `payback` under `MAX_AGE_LIQUIDATE` so users can defend positions during degradation. Keep borrow/withdraw at 600s.

**Option B (conservative):** Block liquidations when `get_both_exchange_rate` would fail. Risks bad debt during extended outages.

---

## Additional Context

- Keeper: `4Q2scHgUyjaVTH6zr6bUdx2vRqN9QvQtqircgJQ17rEW`
- `chainlink_data_streams.rs` exists in deployed oracle binary but is absent from public C4 audit / fluid-source repos
- `timestamp_split_poc.mjs`: `last_observations_timestamp` not checked on operate read path; all three timestamps stay ~2s apart on mainnet under normal operation (defense-in-depth gap, not independently exploitable)