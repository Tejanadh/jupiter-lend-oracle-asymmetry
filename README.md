# Jupiter Lend — Oracle Staleness Asymmetry (High)

Security research on Jupiter Lend's Chainlink Data Streams oracle integration.

## Finding

When a keeper stops refreshing oracle caches, a **601s–7200s window** opens where:

- **All vault user operations are blocked** (`deposit`, `withdraw`, `borrow`, `payback`)
- **Liquidations continue** on stale prices (up to 2 hours)

Users cannot self-rescue while liquidators can still act. See [FINDING.md](./FINDING.md) for the full report.

**Severity:** High (not Critical)

## Proof of Concept

Requires [Surfpool](https://surfpool.dev/) mainnet fork.

```bash
cd poc
npm install
./start_surfpool.sh   # terminal 1 — keep open

# terminal 2
LOCAL_RPC=http://127.0.0.1:8899 npm run test:asymmetry
LOCAL_RPC=http://127.0.0.1:8899 npm run test:both-rates
LOCAL_RPC=http://127.0.0.1:8899 npm run test:staleness
```

| Script | What it proves |
|--------|----------------|
| `asymmetry_poc.mjs` | At 631s: operate fails, liquidate succeeds |
| `both_rates_poc.mjs` | `get_both_exchange_rate` fails → all vault ops blocked |
| `staleness_poc.mjs` | Read-path staleness bypass hypothesis **disproven** |
| `timestamp_split_poc.mjs` | Which cache timestamp fields gate staleness |

## Affected Programs (Mainnet)

| Program | Address |
|---------|---------|
| Oracle | `jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc` |
| Vaults | `jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi` |

All 4 xStocks/RWA Chainlink DS oracle pairs (nonces 60–63).

## Disclaimer

Independent security research. Not affiliated with Jupiter. Submitted for responsible disclosure / bounty review.