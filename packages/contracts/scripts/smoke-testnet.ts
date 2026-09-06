import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";

/**
 * Full-loop smoke test against a live deployment:
 *   fund token -> publish -> openSession -> sign voucher -> settle -> closeSession
 *
 * The deployer acts as author + treasury. A fresh throwaway wallet acts as the
 * reader, funded with MON for gas plus payment tokens for the stream (WMON via
 * deposit(), or MockERC20 via mint()), so the reader<->author value flow is
 * exercised across distinct addresses.
 */
const wethAbi = [
  "function deposit() payable",
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

async function main() {
  if (network.name !== "monadTestnet") throw new Error("run with --network monadTestnet");

  const rec = JSON.parse(readFileSync(join(__dirname, "..", "deployments", "monadTestnet.json"), "utf8"));
  const { ArticleRegistry: registryAddr, AttentionStream: streamAddr, paymentToken: tokenAddr } = rec.contracts;

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("no deployer signer");

  const registry = await ethers.getContractAt("ArticleRegistry", registryAddr, deployer);
  const streamAsDeployer = await ethers.getContractAt("AttentionStream", streamAddr, deployer);

  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);

  // --- reader wallet -------------------------------------------------------
  const reader = ethers.Wallet.createRandom().connect(ethers.provider);
  console.log(`Deployer (author+treasury): ${deployer.address}`);
  console.log(`Reader (throwaway):         ${reader.address}`);
  console.log(`Payment token:             ${tokenAddr} (${rec.paymentTokenIsMock ? "MockERC20" : "WMON"})`);

  const ratePerSec = 1_000_000_000_000_000n; // 1e15 base units / sec
  const budget = 60n * ratePerSec; // 6e16
  const fund = budget * 2n;
  const gasTopUp = ethers.parseEther("0.3");

  console.log(`\nFunding reader: ${ethers.formatEther(gasTopUp)} MON gas + ${ethers.formatUnits(fund, 18)} payment tokens`);
  await (await deployer.sendTransaction({ to: reader.address, value: gasTopUp })).wait();

  const tokenAsReader = new ethers.Contract(tokenAddr, wethAbi, reader);
  if (rec.paymentTokenIsMock) {
    const mock = await ethers.getContractAt("MockERC20", tokenAddr, deployer);
    await (await mock.mint(reader.address, fund)).wait();
  } else {
    // Deployer wraps MON -> WMON and sends it to the reader. Monad testnet
    // applies state effects a bit after the receipt, so poll for the balance
    // between the dependent txs.
    const tokenAsDeployer = new ethers.Contract(tokenAddr, wethAbi, deployer);
    await (await tokenAsDeployer.deposit({ value: fund })).wait();
    await waitForBalance(tokenAsDeployer, deployer.address, fund, "deployer WMON");
    await (await tokenAsDeployer.transfer(reader.address, fund)).wait();
  }
  await waitForBalance(tokenAsReader, reader.address, fund, "reader payment tokens");

  // --- publish -----------------------------------------------------------
  const contentHash = ethers.keccak256(ethers.toUtf8Bytes(`smoke ${Date.now()}`));
  const pubRc = await (await registry.publish(contentHash, "ipfs://smoke")).wait();
  const publishedEv = pubRc!.logs
    .map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } })
    .find((e) => e?.name === "Published");
  const articleId: bigint = publishedEv!.args.id;
  console.log(`\nPublished article id ${articleId}`);

  // --- openSession -----------------------------------------------------
  const streamAsReader = streamAsDeployer.connect(reader);
  const sessionKey = ethers.Wallet.createRandom();

  await (await tokenAsReader.approve(streamAddr, budget)).wait();
  const openRc = await (await streamAsReader.openSession(articleId, budget, ratePerSec, sessionKey.address)).wait();
  const openedEv = openRc!.logs
    .map((l) => { try { return streamAsReader.interface.parseLog(l); } catch { return null; } })
    .find((e) => e?.name === "SessionOpened");
  const sessionId: string = openedEv!.args.id;
  console.log(`openSession: ${sessionId}`);
  console.log(`  session key: ${sessionKey.address}`);

  const readerAfterOpen: bigint = await tokenAsReader.balanceOf(reader.address);
  const deployerBeforeSettle: bigint = await tokenAsReader.balanceOf(deployer.address);

  // --- wait so the rate cap ratePerSec*(elapsed+1) covers our voucher ---
  const waitS = 15;
  console.log(`\nwaiting ${waitS}s for engagement to accrue on-chain...`);
  await new Promise((r) => setTimeout(r, waitS * 1000));

  // --- sign + settle a voucher --------------------------------------------
  const cumulative = 5n * ratePerSec; // 5 "engaged seconds"
  const domain = { name: "AttentionStream", version: "1", chainId, verifyingContract: streamAddr };
  const types = { Voucher: [{ name: "sessionId", type: "bytes32" }, { name: "cumulativeAmount", type: "uint256" }] };
  const signature = await sessionKey.signTypedData(domain, types, { sessionId, cumulativeAmount: cumulative });

  await (await streamAsDeployer.settle(sessionId, cumulative, signature)).wait();
  const fee = (cumulative * BigInt(rec.protocolFeeBps)) / 10_000n;
  const sess = await streamAsDeployer.sessions(sessionId);
  console.log(`\nsettle(${ethers.formatUnits(cumulative, 18)}): claimed now ${ethers.formatUnits(sess.claimed, 18)}, fee ${ethers.formatUnits(fee, 18)}`);

  const deployerAfterSettle: bigint = await tokenAsReader.balanceOf(deployer.address);
  assertEq(deployerAfterSettle - deployerBeforeSettle, cumulative, "deployer (author+treasury) balance delta == cumulative");
  assertEq(sess.claimed, cumulative, "session.claimed == cumulative");
  assertEq(await streamAsDeployer.articleEarned(articleId), cumulative, "articleEarned == cumulative");

  // --- two-phase closure ----------------------------------------------------
  // Shrink the challenge window so the canary doesn't wait 15 minutes.
  const origWindow: bigint = await streamAsDeployer.challengeWindow();
  await (await streamAsDeployer.setChallengeWindow(60)).wait();
  console.log(`\nchallengeWindow ${origWindow} -> 60s for the canary`);

  try {
    // phase 1: closeSession takes no voucher, only freezes accrual
    await (await streamAsReader.closeSession(sessionId)).wait();
    const closing = await streamAsDeployer.sessions(sessionId);
    const cAt: bigint = await streamAsDeployer.closeInitiatedAt(sessionId);
    console.log(`closeSession: open ${closing.open}, closeInitiatedAt ${cAt}`);
    assertEq(closing.open, true, "session still open during the challenge window");
    assertEq(cAt > 0n, true, "closeInitiatedAt recorded");

    // a fresh voucher signed at/under the close-time cap still settles in the window
    const inWindow = 7n * ratePerSec;
    const sig2 = await sessionKey.signTypedData(domain, types, { sessionId, cumulativeAmount: inWindow });
    const dBefore = await tokenAsReader.balanceOf(deployer.address);
    await (await streamAsDeployer.settle(sessionId, inWindow, sig2)).wait();
    assertEq((await streamAsDeployer.sessions(sessionId)).claimed, inWindow, "in-window settle raised claimed");
    assertEq((await tokenAsReader.balanceOf(deployer.address)) - dBefore, inWindow - cumulative, "author paid the in-window delta");

    // finalize before the window elapses -> revert
    await assertReverts(() => streamAsReader.finalizeSession(sessionId), "ChallengeWindowOpen", "finalize before window");

    console.log("waiting 65s for the challenge window to elapse...");
    await new Promise((r) => setTimeout(r, 65_000));

    // settle after the window -> revert
    const late = 9n * ratePerSec;
    const sig3 = await sessionKey.signTypedData(domain, types, { sessionId, cumulativeAmount: late });
    await assertReverts(() => streamAsDeployer.settle(sessionId, late, sig3), "ChallengeWindowClosed", "settle after window");

    // phase 2: permissionless finalize refunds budget - claimed
    await (await streamAsDeployer.finalizeSession(sessionId)).wait();
    const closed = await streamAsDeployer.sessions(sessionId);
    const readerFinal: bigint = await tokenAsReader.balanceOf(reader.address);
    console.log(`finalizeSession: open now ${closed.open}`);
    assertEq(closed.open, false, "session.open == false after finalize");
    assertEq(readerFinal, readerAfterOpen + (budget - inWindow), "reader refunded budget - claimed");
    assertEq(readerFinal, fund - inWindow, "reader net token spend == claimed");
  } finally {
    await (await streamAsDeployer.setChallengeWindow(origWindow)).wait();
    console.log(`challengeWindow restored to ${origWindow}`);
  }

  console.log("\n✅ full loop OK: fund → publish → openSession → voucher → settle → close → window → finalize");
}

async function assertReverts(fn: () => Promise<unknown>, want: string, label: string) {
  try {
    const tx = (await fn()) as { wait?: () => Promise<unknown> };
    if (tx?.wait) await tx.wait();
  } catch (e) {
    const err = e as {
      revert?: { name?: string };
      shortMessage?: string;
      data?: string;
      info?: { error?: { data?: string } };
    };
    const name =
      err?.revert?.name ??
      err?.shortMessage?.match(/custom error '([A-Za-z0-9_]+)/)?.[1] ??
      null;
    if (name === want) {
      console.log(`  ✓ ${label} reverts ${name}`);
    } else if (name === null) {
      console.log(`  ⚠ ${label} reverted, but the RPC did not surface the name (expected ${want})`);
    } else {
      throw new Error(`${label}: expected ${want}, got ${name}`);
    }
    return;
  }
  throw new Error(`${label}: expected revert ${want}, did not revert`);
}

function assertEq(a: unknown, b: unknown, label: string) {
  const ok = a === b || String(a) === String(b);
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : `  (${a} !== ${b})`}`);
  if (!ok) throw new Error(`assertion failed: ${label}`);
}

async function waitForBalance(
  token: InstanceType<typeof ethers.Contract>,
  who: string,
  target: bigint,
  label: string,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await token.balanceOf(who)) >= target) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out waiting for ${label} balance >= ${target}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
