import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";

/**
 * Phase 2 of the two-phase closure: `finalizeSession(id)` on the current
 * AttentionStream. Permissionless once `closeInitiatedAt + challengeWindow` has
 * elapsed — the refund (`budget - claimed`) always goes to the session `reader`,
 * regardless of who sends the tx. Uses the account behind DEPLOYER_KEY in
 * packages/contracts/.env only to pay gas.
 *
 *   SESSION_ID=0x... npm run finalize-session:monad
 *
 * Use this to clear a session that was `closeSession`d from the web UI but never
 * finalized (e.g. the page was refreshed, or it never sent a voucher so the
 * collector's auto-finalizer never tracked it).
 */
async function main() {
  if (network.name !== "monadTestnet") throw new Error("run with --network monadTestnet");

  const id = (process.env.SESSION_ID ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new Error(`SESSION_ID must be 32-byte hex, got "${id}"`);

  const dep = JSON.parse(readFileSync(join(__dirname, "..", "deployments", "monadTestnet.json"), "utf8"));
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("no signer — set DEPLOYER_KEY in packages/contracts/.env");

  const stream = await ethers.getContractAt("AttentionStream", dep.contracts.AttentionStream, signer);
  const wmon = await ethers.getContractAt("IERC20", dep.contracts.paymentToken, signer);

  const s = await stream.sessions(id);
  const closeInitiatedAt: bigint = await stream.closeInitiatedAt(id);
  const challengeWindow: bigint = await stream.challengeWindow();
  const now = BigInt(Math.floor(Date.now() / 1000));

  console.log(`AttentionStream : ${dep.contracts.AttentionStream}`);
  console.log(`Session         : ${id}`);
  console.log(`  open          : ${s.open}`);
  console.log(`  reader        : ${s.reader}`);
  console.log(`  budget        : ${ethers.formatUnits(s.budget, 18)} WMON`);
  console.log(`  claimed       : ${ethers.formatUnits(s.claimed, 18)} WMON`);
  console.log(`  closeInitiated: ${closeInitiatedAt} ${closeInitiatedAt > 0n ? `(${new Date(Number(closeInitiatedAt) * 1000).toISOString()})` : ""}`);
  console.log(`  challengeWin  : ${challengeWindow}s`);
  console.log(`Sender (gas)    : ${signer.address}`);

  if (!s.open) throw new Error("session already finalized (open == false) — nothing to do");
  if (closeInitiatedAt === 0n) throw new Error("closeSession has not been called for this session yet");
  const readyAt = closeInitiatedAt + challengeWindow;
  if (now <= readyAt) {
    throw new Error(`challenge window still open — finalize allowed at ${new Date(Number(readyAt) * 1000).toISOString()} (${readyAt - now}s to go)`);
  }

  const refund = s.budget - s.claimed;
  const readerBefore: bigint = await wmon.balanceOf(s.reader);
  console.log(`\nRefund to reader: ${ethers.formatUnits(refund, 18)} WMON  ->  ${s.reader}`);

  const tx = await stream.finalizeSession(id);
  console.log(`\nfinalizeSession : ${tx.hash}`);
  const rc = await tx.wait();

  const ev = rc!.logs
    .map((l: { topics: readonly string[]; data: string }) => {
      try {
        return stream.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e: { name: string } | null) => e?.name === "SessionClosed");
  if (ev) {
    console.log(
      `SessionClosed   : totalPaid ${ethers.formatUnits(ev.args.totalPaid, 18)} · ` +
        `refunded ${ethers.formatUnits(ev.args.refunded, 18)} WMON · duration ${ev.args.duration}s`,
    );
  }

  const readerAfter: bigint = await wmon.balanceOf(s.reader);
  console.log(`\nreader WMON ${ethers.formatUnits(readerBefore, 18)} -> ${ethers.formatUnits(readerAfter, 18)}  (+${ethers.formatUnits(readerAfter - readerBefore, 18)})`);
  const post = await stream.sessions(id);
  console.log(post.open ? "\n⚠️  still open — check the tx" : "\n✅ finalized and refunded");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
