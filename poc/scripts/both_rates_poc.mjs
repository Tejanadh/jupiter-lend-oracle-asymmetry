#!/usr/bin/env node
/** Verify get_both_exchange_rate fails when operate path fails at 631s stale. */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { TARGET, ORACLE_PROGRAM_ID, STALE_WARP_SECS } from "./constants.mjs";

const LOCAL_RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:8899";
const BOTH_DISC = Buffer.from([92, 88, 161, 46, 230, 193, 46, 237]);

async function surfnetRpc(method, params) {
  const res = await fetch(LOCAL_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

function parseCache(buf) {
  let off = 8 + 2;
  const feedCount = buf.readUInt32LE(off);
  off += 4 + feedCount * 34 + 16;
  return { priceOff: off, multOff: off + 8, obsOff: off + 16 };
}

async function patchAll(cachePk, ts, conn) {
  const info = await conn.getAccountInfo(new PublicKey(cachePk));
  const buf = Buffer.from(info.data);
  const o = parseCache(buf);
  const obsMs = ts * 1000;
  buf.writeBigUInt64LE(BigInt(ts), o.priceOff);
  buf.writeBigUInt64LE(BigInt(ts), o.multOff);
  buf.writeBigUInt64LE(BigInt(obsMs), o.obsOff);
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

async function simBoth(conn, payer) {
  const data = Buffer.alloc(10);
  BOTH_DISC.copy(data, 0);
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
  const err = sim.value.logs?.find((l) => l.includes("Error Code")) ?? (sim.value.err ? "FAIL" : "OK");
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
  await patchAll(TARGET.cache, nowTs - 30, conn);
  console.log("Fresh (30s):", await simBoth(conn, payer));

  await surfnetRpc("surfnet_timeTravel", [{ absoluteTimestamp: (nowTs + STALE_WARP_SECS) * 1000 }]);
  await patchAll(TARGET.cache, nowTs - 30, conn); // keep cache stale
  console.log(`Stale (+${STALE_WARP_SECS}s warp, cache unchanged):`, await simBoth(conn, payer));
}

main().catch(console.error);
