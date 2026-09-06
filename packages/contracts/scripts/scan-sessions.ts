import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";

/**
 * Exhaustive: enumerate EVERY session a reader has opened on the current
 * AttentionStream and report which are still open with recoverable budget.
 *
 * Two independent methods, cross-checked:
 *   A. Derive ids from storage. `openSession` sets
 *        id = keccak256(abi.encode(reader, nonce, chainId, articleId, stream))
 *      with nonce in [0, openCount[reader]). articleId isn't stored per nonce,
 *      so try every articleId in [1, nextId) for each nonce and probe the
 *      `sessions` mapping.
 *   B. Scan `SessionOpened(reader indexed)` logs from the deploy block to head.
 *
 *   READER=0x... npm run scan-sessions:monad     (defaults to DEPLOYER_KEY's address)
 */
async function main() {
  if (network.name !== "monadTestnet") throw new Error("run with --network monadTestnet");

  const dep = JSON.parse(readFileSync(join(__dirname, "..", "deployments", "monadTestnet.json"), "utf8"));
  const streamAddr: string = dep.contracts.AttentionStream;
  const registryAddr: string = dep.contracts.ArticleRegistry;
  const p = ethers.provider;
  const net = await p.getNetwork();
  const chainId = net.chainId; // bigint

  const [signer] = await ethers.getSigners();
  const reader = ethers.getAddress((process.env.READER ?? signer?.address ?? "").trim());
  if (!reader) throw new Error("set READER or DEPLOYER_KEY");

  const stream = await ethers.getContractAt("AttentionStream", streamAddr);
  const registry = await ethers.getContractAt("ArticleRegistry", registryAddr);

  const openCount: bigint = await stream.openCount(reader);
  const nextId: bigint = await registry.nextId();
  console.log(`AttentionStream : ${streamAddr}`);
  console.log(`Reader          : ${reader}`);
  console.log(`openCount[reader]: ${openCount}   (sessions this reader has opened here)`);
  console.log(`article ids      : 1..${nextId - 1n}\n`);

  const coder = ethers.AbiCoder.defaultAbiCoder();
  type Row = { id: string; nonce: number; articleId: bigint; open: boolean; budget: bigint; claimed: bigint };
  const found: Row[] = [];
  const foundIds = new Set<string>();

  // --- Method A: derive + probe ---
  for (let nonce = 0n; nonce < openCount; nonce++) {
    let hit = false;
    for (let a = 1n; a < nextId; a++) {
      const id = ethers.keccak256(
        coder.encode(["address", "uint256", "uint256", "uint64", "address"], [reader, nonce, chainId, a, streamAddr]),
      );
      const s = await stream.sessions(id);
      if (s.reader !== ethers.ZeroAddress) {
        found.push({ id, nonce: Number(nonce), articleId: a, open: s.open, budget: s.budget, claimed: s.claimed });
        foundIds.add(id.toLowerCase());
        hit = true;
        break;
      }
    }
    if (!hit) console.log(`  nonce ${nonce}: no session found for any articleId (unexpected)`);
  }

  console.log(`Method A (storage derivation): ${found.length} session(s)`);
  let refundable = 0n;
  for (const r of found) {
    const ref = r.open ? r.budget - r.claimed : 0n;
    refundable += ref;
    console.log(
      `  ${r.id.slice(0, 12)}…  nonce=${r.nonce}  article=${r.articleId}  open=${r.open}  ` +
        `budget=${ethers.formatUnits(r.budget, 18)}  claimed=${ethers.formatUnits(r.claimed, 18)}  ` +
        `refundable=${ethers.formatUnits(ref, 18)}`,
    );
  }

  // --- Method B: SessionOpened logs (cross-check) ---
  const topic0 = ethers.id("SessionOpened(bytes32,uint256,address,address,address,uint96,uint64)");
  const readerTopic = ethers.zeroPadValue(reader.toLowerCase(), 32);
  const head = await p.getBlockNumber();
  // Start block: binary-search on block *timestamps* (header data, always served)
  // for the deployment time recorded in the JSON, minus a day of slack.
  let deployBlock: number;
  if (process.env.FROM_BLOCK) {
    deployBlock = Number(process.env.FROM_BLOCK);
  } else {
    const targetTs = Math.floor(new Date(dep.deployedAt).getTime() / 1000) - 86_400;
    let blo = 1,
      bhi = head;
    while (blo < bhi) {
      const bmid = (blo + bhi) >> 1;
      const blk = await p.getBlock(bmid);
      if (blk && Number(blk.timestamp) < targetTs) blo = bmid + 1;
      else bhi = bmid;
    }
    deployBlock = blo;
  }
  console.log(`\nMethod B (SessionOpened logs from block ${deployBlock} to ${head}, ${head - deployBlock} blocks)`);

  const eventIds = new Set<string>();
  let range = 900;
  for (let from = deployBlock; from <= head; ) {
    const to = Math.min(from + range - 1, head);
    try {
      const logs = await p.getLogs({ address: streamAddr, topics: [topic0, null, null, readerTopic], fromBlock: from, toBlock: to });
      for (const l of logs) eventIds.add(l.topics[1].toLowerCase()); // topics[1] = id
      from = to + 1;
    } catch (e) {
      if (range > 100) {
        range = Math.max(100, Math.floor(range / 2));
        continue;
      }
      console.log(`  getLogs failed at floor range near block ${from}: ${String(e).slice(0, 120)}`);
      break;
    }
  }
  console.log(`  ${eventIds.size} SessionOpened event(s) for this reader`);

  // --- reconcile ---
  const onlyA = [...foundIds].filter((x) => !eventIds.has(x));
  const onlyB = [...eventIds].filter((x) => !foundIds.has(x));
  console.log(`\nReconcile: A∩B = ${[...foundIds].filter((x) => eventIds.has(x)).length}  ·  only in A = ${onlyA.length}  ·  only in B = ${onlyB.length}`);
  if (onlyB.length) {
    console.log("  ⚠️  sessions in events but not derived — probing them:");
    for (const id of onlyB) {
      const s = await stream.sessions(id);
      console.log(`    ${id}  open=${s.open}  budget=${ethers.formatUnits(s.budget, 18)}  claimed=${ethers.formatUnits(s.claimed, 18)}  refundable=${ethers.formatUnits(s.open ? s.budget - s.claimed : 0n, 18)}`);
    }
  }

  const stillOpen = found.filter((r) => r.open);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`STILL OPEN: ${stillOpen.length} session(s)  ·  recoverable budget: ${ethers.formatUnits(refundable, 18)} WMON`);
  if (stillOpen.length) {
    console.log("close each with:  SESSION_ID=<id> npm run close-session:monad");
    for (const r of stillOpen) console.log(`  ${r.id}`);
  } else {
    console.log("nothing to recover — safe to redeploy.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
