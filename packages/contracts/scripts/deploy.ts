import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) {
    throw new Error(
      "No deployer account. Set DEPLOYER_KEY in packages/contracts/.env (0x-prefixed, 64 hex chars).",
    );
  }

  const net = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`Network:  ${network.name} (chainId ${net.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(balance)} MON`);

  if (balance === 0n) {
    console.error(
      `\nDeployer has no balance. Fund ${deployer.address} with testnet MON ` +
        `(faucet: https://faucet.monad.xyz) and re-run.`,
    );
    process.exitCode = 1;
    return;
  }

  const feeBps = Number(process.env.PROTOCOL_FEE_BPS ?? "250");

  // 1. ArticleRegistry: reuse ARTICLE_REGISTRY if set, else deploy a fresh one.
  let registryAddr = process.env.ARTICLE_REGISTRY?.trim();
  if (registryAddr) {
    if ((await ethers.provider.getCode(registryAddr)) === "0x") {
      throw new Error(`ARTICLE_REGISTRY ${registryAddr} has no code on ${network.name}`);
    }
    console.log(`ArticleRegistry: ${registryAddr}  (reused)`);
  } else {
    const registry = await (await ethers.getContractFactory("ArticleRegistry")).deploy();
    await registry.waitForDeployment();
    registryAddr = await registry.getAddress();
    console.log(`ArticleRegistry: ${registryAddr}  (new)`);
  }

  // 2. Payment token: reuse PAYMENT_TOKEN if set, else deploy a mock.
  let tokenAddr = process.env.PAYMENT_TOKEN?.trim();
  let tokenIsMock = false;
  if (!tokenAddr) {
    const mock = await (await ethers.getContractFactory("MockERC20")).deploy();
    await mock.waitForDeployment();
    tokenAddr = await mock.getAddress();
    tokenIsMock = true;
    console.log(`MockERC20:       ${tokenAddr}  (no PAYMENT_TOKEN provided)`);
  } else {
    if ((await ethers.provider.getCode(tokenAddr)) === "0x") {
      throw new Error(`PAYMENT_TOKEN ${tokenAddr} has no code on ${network.name}`);
    }
    console.log(`Payment token:   ${tokenAddr}`);
  }

  // 3. AttentionStream
  const stream = await (await ethers.getContractFactory("AttentionStream")).deploy(
    tokenAddr,
    registryAddr,
    deployer.address, // treasury
    feeBps,
  );
  await stream.waitForDeployment();
  const streamAddr = await stream.getAddress();
  console.log(`AttentionStream: ${streamAddr}  (fee ${feeBps} bps)`);

  const record = {
    network: network.name,
    chainId: Number(net.chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      ArticleRegistry: registryAddr,
      AttentionStream: streamAddr,
      paymentToken: tokenAddr,
    },
    paymentTokenIsMock: tokenIsMock,
    protocolFeeBps: feeBps,
    treasury: deployer.address,
  };

  const outDir = join(__dirname, "..", "deployments");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${network.name}.json`);
  writeFileSync(outFile, JSON.stringify(record, null, 2) + "\n");
  console.log(`\nWrote ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
