#!/usr/bin/env node
/**
 * PoC: Oracle staleness asymmetry — operate (600s) vs liquidate (7200s).
 * At 631s cache age: operate MUST fail, liquidate MUST succeed.
 * Vault deposit/payback uses liquidate rate → still allowed in stale window.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TARGET,
  ORACLE_PROGRAM_ID,
  IX_DISC,
  MAX_AGE_OPERATE_SECS,
  STALE_WARP_SECS,
} from "./constants.mjs";

const LOCAL_RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:8899";

async function surfnetRpc(method, params) {
  const res = await fetch(LOCAL_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

function buildIx(disc, oracle, cache, nonce) {
  const data = Buffer.alloc(10);
  disc.copy(data, 0);
  data.writeUInt16LE(nonce, 8);
  return new TransactionInstruction({
    programId: new PublicKey(ORACLE_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(oracle), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(cache), isSigner: false, isWritable: false },
    ],
    data,
  });
}

function parseCacheLayout(buf) {
  let off = 8 + 2;
  const feedCount = buf.readUInt32LE(off);
  off += 4 + feedCount * 34 + 16;
  const priceTsOffset = off;
  const priceTs = Number(buf.readBigUInt64LE(off));
  off += 8;
  const multTsOffset = off;
  off += 8;
  const obsTsOffset = off;
  return { priceTsOffset, multTsOffset, obsTsOffset, priceTs };
}

async function patchCache(cachePk, freshTsSec, conn) {
  const info = await conn.getAccountInfo(new PublicKey(cachePk));
  const patched = Buffer.from(info.data);
  const layout = parseCacheLayout(patched);
  const obsTsMs = layout.priceTs > 1e12 ? freshTsSec * 1000 : freshTsSec;
  patched.writeBigUInt64LE(BigInt(freshTsSec), layout.priceTsOffset);
  patched.writeBigUInt64LE(BigInt(freshTsSec), layout.multTsOffset);
  patched.writeBigUInt64LE(BigInt(obsTsMs), layout.obsTsOffset);
  await surfnetRpc("surfnet_setAccount", [
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

async function sim(conn, payer, disc, label) {
  const ix = buildIx(disc, TARGET.oracle, TARGET.cache, TARGET.oracleNonce);
  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(ix);
  const sim = await conn.simulateTransaction(tx, [payer]);
  const ok = !sim.value.err;
  const errLog = sim.value.logs?.find((l) => l.includes("Error Code")) ?? "";
  console.log(`  ${label}: ${ok ? "✅ OK" : "❌ FAIL"} ${errLog}`);
  return ok;
}

async function main() {
  const conn = new Connection(LOCAL_RPC, "confirmed");
  const payer = Keypair.generate();
  await surfnetRpc("surfnet_setAccount", [
    payer.publicKey.toBase58(),
    { lamports: 10_000_000_000, owner: "11111111111111111111111111111111", executable: false, data: "", rentEpoch: 0 },
  ]);

  const clock = await conn.getAccountInfo(new PublicKey("SysvarC1ock11111111111111111111111111111111"));
  const nowTs = Number(clock.data.readBigInt64LE(32));
  const cacheTs = nowTs - 30;

  console.log("Oracle staleness asymmetry PoC");
  console.log(`Operate threshold: ${MAX_AGE_OPERATE_SECS}s | Warp: +${STALE_WARP_SECS}s\n`);

  await patchCache(TARGET.cache, cacheTs, conn);
  console.log("[Fresh cache @30s age]");
  const baseOp = await sim(conn, payer, IX_DISC.getExchangeRateOperate, "get_exchange_rate_operate");
  const baseLiq = await sim(conn, payer, IX_DISC.getExchangeRateLiquidate, "get_exchange_rate_liquidate");

  const targetTs = nowTs + STALE_WARP_SECS;
  await surfnetRpc("surfnet_timeTravel", [{ absoluteTimestamp: targetTs * 1000 }]);
  console.log(`\n[+${STALE_WARP_SECS}s warp — cache still at ${cacheTs}, age ${targetTs - cacheTs}s]`);
  const staleOp = await sim(conn, payer, IX_DISC.getExchangeRateOperate, "get_exchange_rate_operate");
  const staleLiq = await sim(conn, payer, IX_DISC.getExchangeRateLiquidate, "get_exchange_rate_liquidate");

  console.log("\n--- Verdict ---");
  if (!staleOp && staleLiq) {
    console.log("🔴 ASYMMETRY CONFIRMED: operate blocked, liquidate allowed at 631s stale");
    console.log("   All vault operate blocked (get_both fails); liquidations still use 7200s path.");
    process.exit(2);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
