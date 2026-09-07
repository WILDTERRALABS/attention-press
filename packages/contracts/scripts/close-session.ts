import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";

/**
 * Phase 1 of the two-phase closure: `closeSession(id)` on the current
 * AttentionStream. Records the accrual cutoff and starts the challenge window —
 * it does NOT refund. Run `finalize-session.ts` after the window elapses (or let
 * the collector's settle loop do it).
 *
 *   SESSION_ID=0x... npm run close-session:monad
 *
 * Must be sent by the session `reader` (DEPLOYER_KEY in packages/contracts/.env),
 * unless MAX_ACCRUAL_WINDOW (7 days) has passed, after which anyone may close it.
 */
async function main() {
  if (network.name !== "monadTestnet") throw new Error("run with --network monadTestnet");

  const id = (process.env.SESSION_ID ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new Error(`SESSION_ID must be 32-byte hex, got "${id}"`);

  const dep = JSON.parse(readFileSync(join(__dirname, "..", "deployments", "monadTestnet.json"), "utf8"));
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("no signer — set DEPLOYER_KEY in packages/contracts/.env");

  const stream = await ethers.getContractAt("AttentionStream", dep.contracts.AttentionStream, signer);

  const s = await stream.sessions(id);
  const closeInitiatedAt: bigint = await stream.closeInitiatedAt(id);
  const challengeWindow: bigint = await stream.challengeWindow();

  console.log(`AttentionStream : ${dep.contracts.AttentionStream}`);
  console.log(`Session         : ${id}`);
  console.log(`  open          : ${s.open}`);
  console.log(`  reader        : ${s.reader}`);
  console.log(`  budget        : ${ethers.formatUnits(s.budget, 18)} WMON`);
  console.log(`  claimed       : ${ethers.formatUnits(s.claimed, 18)} WMON`);
  console.log(`  closeInitiated: ${closeInitiatedAt}`);
  console.log(`Sender          : ${signer.address}`);

  if (!s.open) throw new Error("session is not open — nothing to close");
  if (closeInitiatedAt !== 0n) {
    const readyAt = closeInitiatedAt + challengeWindow;
    throw new Error(
      `already in phase 1 (closeInitiatedAt ${closeInitiatedAt}). ` +
        `Run finalize-session.ts after ${new Date(Number(readyAt) * 1000).toISOString()}.`,
    );
  }
  if (s.reader.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`sender is not the session reader (${s.reader}) — set DEPLOYER_KEY to that wallet`);
  }

  const tx = await stream.closeSession(id);
  console.log(`\ncloseSession tx : ${tx.hash}`);
  await tx.wait();

  const cAt: bigint = await stream.closeInitiatedAt(id);
  const readyAt = cAt + challengeWindow;
  console.log(`closeInitiatedAt: ${cAt} (${new Date(Number(cAt) * 1000).toISOString()})`);
  console.log(
    `\n✅ phase 1 done. Refund of ${ethers.formatUnits(s.budget - s.claimed, 18)} WMON is claimable after ` +
      `${new Date(Number(readyAt) * 1000).toISOString()} via:\n` +
      `   SESSION_ID=${id} npm run finalize-session:monad`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
