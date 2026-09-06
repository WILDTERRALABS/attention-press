import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";

/**
 * One-shot: close an OPEN AttentionStream session from the reader wallet and
 * collect the refund (budget - claimed). Uses the account behind DEPLOYER_KEY in
 * packages/contracts/.env, which must be the session's `reader`.
 *
 *   SESSION_ID=0x... npm run close-session:monad
 *
 * Defaults to the known orphaned session on the current deployment. Passing
 * `cumulativeAmount == claimed` with empty `sig` skips voucher verification, so
 * no ephemeral session key is required.
 */
const DEFAULT_SESSION_ID = "0xc89d3490303db8932b73b82286776a60bbf53fda0451463e88504dbd3fc3ea9d";

async function main() {
  if (network.name !== "monadTestnet") throw new Error("run with --network monadTestnet");

  const id = (process.env.SESSION_ID ?? DEFAULT_SESSION_ID).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new Error(`SESSION_ID must be 32-byte hex, got ${id}`);

  const dep = JSON.parse(readFileSync(join(__dirname, "..", "deployments", "monadTestnet.json"), "utf8"));
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("no signer — set DEPLOYER_KEY in packages/contracts/.env");

  const stream = await ethers.getContractAt("AttentionStream", dep.contracts.AttentionStream, signer);
  const wmon = await ethers.getContractAt("IERC20", dep.contracts.paymentToken, signer);

  const s = await stream.sessions(id);
  console.log(`AttentionStream : ${dep.contracts.AttentionStream}`);
  console.log(`Session         : ${id}`);
  console.log(`  open          : ${s.open}`);
  console.log(`  reader        : ${s.reader}`);
  console.log(`  budget        : ${ethers.formatUnits(s.budget, 18)} WMON`);
  console.log(`  claimed       : ${ethers.formatUnits(s.claimed, 18)} WMON`);
  console.log(`Sender          : ${signer.address}`);

  if (!s.open) throw new Error("session is not open — nothing to close");
  if (s.reader.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`sender is not the session reader (${s.reader}) — set DEPLOYER_KEY to that wallet`);
  }

  const refund = s.budget - s.claimed;
  console.log(`\nRefund on close : ${ethers.formatUnits(refund, 18)} WMON`);

  const wmonBefore: bigint = await wmon.balanceOf(signer.address);

  // cumulativeAmount == claimed, empty sig -> _verify is skipped, straight to _finalize
  const tx = await stream.closeSession(id, s.claimed, "0x");
  console.log(`\ncloseSession tx : ${tx.hash}`);
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

  const wmonAfter: bigint = await wmon.balanceOf(signer.address);
  console.log(`\nWMON ${ethers.formatUnits(wmonBefore, 18)} -> ${ethers.formatUnits(wmonAfter, 18)}  (+${ethers.formatUnits(wmonAfter - wmonBefore, 18)})`);
  const now = await stream.sessions(id);
  console.log(`session open now : ${now.open}`);
  console.log(now.open ? "\n⚠️  still open — check the tx" : "\n✅ closed and refunded");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
