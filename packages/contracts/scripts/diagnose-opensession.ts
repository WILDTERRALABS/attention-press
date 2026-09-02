import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";

/**
 * Diagnoses "SessionOpened event not found in transaction receipt".
 *   ADDR=0xReader npx hardhat run scripts/diagnose-opensession.ts --network monadTestnet
 *   TX=0xhash    ... to inspect a specific transaction
 */
async function main() {
  const rec = JSON.parse(readFileSync(join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const { AttentionStream: streamAddr, ArticleRegistry: registryAddr, paymentToken } = rec.contracts;

  console.log(`network:          ${network.name}`);
  console.log(`AttentionStream:  ${streamAddr}`);
  console.log(`  web default:    0xcf3B5EB6dF13Fd6a7D2df26E57549653bB700a9F`);
  console.log(`  match:          ${streamAddr.toLowerCase() === "0xcf3b5eb6df13fd6a7d2df26e57549653bb700a9f"}`);
  console.log(`paymentToken:     ${paymentToken}`);

  // --- (3) event signature / topic0 ---
  const sig = "SessionOpened(bytes32,uint256,address,address,address,uint96,uint64)";
  const topic0 = ethers.id(sig);
  console.log(`\nSessionOpened sig: ${sig}`);
  console.log(`  topic0:          ${topic0}`);

  const stream = await ethers.getContractAt("AttentionStream", streamAddr);
  const ev = stream.interface.getEvent("SessionOpened");
  console.log(`  contract topic0: ${ev.topicHash}   match: ${ev.topicHash === topic0}`);
  console.log(`  contract format: ${ev.format("sighash")}`);

  // --- most recent SessionOpened on-chain: prove the emit shape ---
  // Monad testnet caps eth_getLogs at 100 blocks; scan back in 100-block windows.
  const latest = await ethers.provider.getBlockNumber();
  let logs: Awaited<ReturnType<typeof ethers.provider.getLogs>> = [];
  for (let end = latest; end > latest - 4000 && logs.length === 0; end -= 100) {
    try {
      logs = await ethers.provider.getLogs({ address: streamAddr, topics: [topic0], fromBlock: end - 99, toBlock: end });
    } catch {
      /* window error, keep scanning */
    }
  }
  console.log(`\nrecent SessionOpened logs found: ${logs.length}`);
  if (logs.length > 0) {
    const l = logs[logs.length - 1]!;
    const parsed = stream.interface.parseLog(l)!;
    console.log(`  tx:      ${l.transactionHash}`);
    console.log(`  topics:  ${l.topics.length}  (expect 4: sig + id + articleId + reader)`);
    console.log(`  args:    id=${parsed.args.id} articleId=${parsed.args.articleId} author=${parsed.args.author}`);
    const r = await ethers.provider.getTransactionReceipt(l.transactionHash);
    console.log(`  receipt.status=${r?.status} logs=${r?.logs.length}`);
  }

  // --- (1) inspect a specific tx if given ---
  if (process.env.TX) {
    const r = await ethers.provider.getTransactionReceipt(process.env.TX);
    console.log(`\nTX ${process.env.TX}`);
    if (!r) {
      console.log("  no receipt yet (pending or unknown)");
    } else {
      console.log(`  status:   ${r.status} ${r.status === 0 ? "(REVERTED)" : "(success)"}`);
      console.log(`  to:       ${r.to}`);
      console.log(`  logs:     ${r.logs.length}`);
      const has = r.logs.some((lg) => lg.address.toLowerCase() === streamAddr.toLowerCase() && lg.topics[0] === topic0);
      console.log(`  has SessionOpened from AttentionStream: ${has}`);
    }
  }

  // --- balance / allowance for a reader address ---
  if (process.env.ADDR) {
    const token = await ethers.getContractAt("MockERC20", paymentToken);
    const [bal, allow, sym, dec] = await Promise.all([
      token.balanceOf(process.env.ADDR),
      token.allowance(process.env.ADDR, streamAddr),
      token.symbol(),
      token.decimals(),
    ]);
    console.log(`\nreader ${process.env.ADDR}`);
    console.log(`  ${sym} balance:   ${ethers.formatUnits(bal, dec)}`);
    console.log(`  allowance->stream: ${ethers.formatUnits(allow, dec)}`);
    console.log(`  MON balance:      ${ethers.formatEther(await ethers.provider.getBalance(process.env.ADDR))}`);
    if (bal === 0n) console.log(`  >>> zero ${sym}: openSession's token.safeTransferFrom(reader, ...) will REVERT`);
  } else {
    console.log(`\n(pass ADDR=0xReader to check that wallet's payment-token balance/allowance)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
