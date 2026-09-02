import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";

/**
 * Full-loop smoke test against a live deployment:
 *   mint -> publish -> openSession -> sign voucher -> settle -> closeSession
 *
 * The deployer acts as author + treasury. A fresh throwaway wallet acts as the
 * reader (funded with a little MON for gas + MockERC20 for the stream), so the
 * reader<->author value flow is exercised across distinct addresses.
 */
async function main() {
  if (network.name !== "monadTestnet") throw new Error("run with --network monadTestnet");

  const rec = JSON.parse(readFileSync(join(__dirname, "..", "deployments", "monadTestnet.json"), "utf8"));
  const { ArticleRegistry: registryAddr, AttentionStream: streamAddr, paymentToken: tokenAddr } = rec.contracts;
  if (!rec.paymentTokenIsMock) throw new Error("this smoke test assumes the MockERC20 payment token");

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("no deployer signer");

  const registry = await ethers.getContractAt("ArticleRegistry", registryAddr, deployer);
  const streamAsDeployer = await ethers.getContractAt("AttentionStream", streamAddr, deployer);
  const token = await ethers.getContractAt("MockERC20", tokenAddr, deployer);

  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);

  // --- reader wallet -------------------------------------------------------
  const reader = ethers.Wallet.createRandom().connect(ethers.provider);
  console.log(`Deployer (author+treasury): ${deployer.address}`);
  console.log(`Reader (throwaway):         ${reader.address}`);

  const ratePerSec = 1_000_000_000_000_000n; // 1e15 base units / sec
  const budget = 60n * ratePerSec; // 6e16
  const gasTopUp = ethers.parseEther("0.3");

  console.log(`\nFunding reader: ${ethers.formatEther(gasTopUp)} MON + ${ethers.formatUnits(budget * 4n, 18)} mUSD`);
  await (await deployer.sendTransaction({ to: reader.address, value: gasTopUp })).wait();
  await (await token.mint(reader.address, budget * 4n)).wait();

  // --- publish -----------------------------------------------------------
  const contentHash = ethers.keccak256(ethers.toUtf8Bytes(`smoke ${Date.now()}`));
  const pubRc = await (await registry.publish(contentHash, "ipfs://smoke")).wait();
  const publishedEv = pubRc!.logs
    .map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } })
    .find((e) => e?.name === "Published");
  const articleId: bigint = publishedEv!.args.id;
  console.log(`\nPublished article id ${articleId}`);

  // --- openSession -----------------------------------------------------
  const tokenAsReader = token.connect(reader);
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

  const readerAfterOpen = await token.balanceOf(reader.address);
  const deployerBeforeSettle = await token.balanceOf(deployer.address);

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
  console.log(`\nsettle(${ethers.formatUnits(cumulative, 18)}): claimed now ${ethers.formatUnits(sess.claimed, 18)} mUSD, fee ${ethers.formatUnits(fee, 18)}`);

  const deployerAfterSettle = await token.balanceOf(deployer.address);
  assertEq(deployerAfterSettle - deployerBeforeSettle, cumulative, "deployer (author+treasury) balance delta == cumulative");
  assertEq(sess.claimed, cumulative, "session.claimed == cumulative");
  assertEq(await streamAsDeployer.articleEarned(articleId), cumulative, "articleEarned == cumulative");

  // --- closeSession ------------------------------------------------------
  await (await streamAsReader.closeSession(sessionId, cumulative, signature)).wait();
  const closed = await streamAsDeployer.sessions(sessionId);
  const readerFinal = await token.balanceOf(reader.address);
  console.log(`\ncloseSession: open now ${closed.open}`);
  assertEq(closed.open, false, "session.open == false after close");
  assertEq(readerAfterOpen + (budget - cumulative), readerFinal, "reader refunded budget - cumulative");
  assertEq(readerFinal, budget * 4n - cumulative, "reader net mUSD spend == cumulative");

  console.log("\n✅ full loop OK: mint → publish → openSession → voucher → settle → closeSession");
}

function assertEq(a: unknown, b: unknown, label: string) {
  const ok = a === b || String(a) === String(b);
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : `  (${a} !== ${b})`}`);
  if (!ok) throw new Error(`assertion failed: ${label}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
