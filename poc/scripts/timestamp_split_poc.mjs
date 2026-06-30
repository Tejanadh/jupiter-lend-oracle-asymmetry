#!/usr/bin/env node
/**
 * Test which cache timestamp fields gate get_exchange_rate_operate staleness.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { TARGET, ORACLE_PROGRAM_ID, IX_DISC } from "./constants.mjs";

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

function parseCache(buf) {
  let off = 8 + 2;
  const feedCount = buf.readUInt32LE(off);
  off += 4 + feedCount * 34 + 16;
  return { priceOff: off, multOff: off + 8, obsOff: off + 16 };
}

async function setCache(cachePk, { priceTs, multTs, obsTs }, conn) {
  const info = await conn.getAccountInfo(new PublicKey(cachePk));
  const buf = Buffer.from(info.data);
  const o = parseCache(buf);
  buf.writeBigUInt64LE(BigInt(priceTs), o.priceOff);
  buf.writeBigUInt64LE(BigInt(multTs), o.multOff);
  buf.writeBigUInt64LE(BigInt(obsTs), o.obsOff);
  await surfnetRpc("surfnet_setAccount", [
    cachePk,
    {
      lamports: info.lamports,
      owner: info.owner.toBase58(),
      executable: info.executable,
      rentEpoch: 0,
      data: buf.toString("hex"),
    },
  ]);
}

async function simOperate(conn, payer) {
  const data = Buffer.alloc(10);
  IX_DISC.getExchangeRateOperate.copy(data, 0);
  data.writeUInt16LE(TARGET.oracleNonce, 8);
  const ix = new TransactionInstruction({
    programId: new PublicKey(ORACLE_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(TARGET.oracle), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(TARGET.cache), isSigner: false, isWritable: false },
    ],
    data,
  });
  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(ix);
  const sim = await conn.simulateTransaction(tx, [payer]);
  const err = sim.value.logs?.find((l) => l.includes("Error Code")) ?? (sim.value.err ? JSON.stringify(sim.value.err) : "OK");
  return { ok: !sim.value.err, err };
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
  const freshTs = nowTs - 30;
  const staleTs = nowTs - 2000; // 2000s > 600s and > 7200s? no 2000 < 7200
  const veryStaleTs = nowTs - 8000; // > 7200s
  const obsFreshMs = freshTs * 1000;
  const obsStaleMs = staleTs * 1000;

  const cases = [
    { name: "all fresh", priceTs: freshTs, multTs: freshTs, obsTs: obsFreshMs },
    { name: "price stale 2000s, obs fresh", priceTs: staleTs, multTs: freshTs, obsTs: obsFreshMs },
    { name: "price fresh, obs stale 2000s (ms)", priceTs: freshTs, multTs: freshTs, obsTs: obsStaleMs },
    { name: "price very stale 8000s", priceTs: veryStaleTs, multTs: freshTs, obsTs: obsFreshMs },
    { name: "mult stale 2000s, price fresh", priceTs: freshTs, multTs: staleTs, obsTs: obsFreshMs },
  ];

  console.log(`Clock now=${nowTs}\n`);
  for (const c of cases) {
    await setCache(TARGET.cache, c, conn);
    const r = await simOperate(conn, payer);
    console.log(`${c.name}: ${r.ok ? "PASS" : "REJECT"} — ${r.err}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
