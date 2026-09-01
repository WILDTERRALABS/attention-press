import { ethers, network } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);

  const feeBps = Number(process.env.PROTOCOL_FEE_BPS ?? "250");

  // 1. ArticleRegistry
  const registry = await (await ethers.getContractFactory("ArticleRegistry")).deploy();
  await registry.waitForDeployment();
  console.log(`ArticleRegistry: ${await registry.getAddress()}`);

  // 2. Payment token: reuse PAYMENT_TOKEN if set, else deploy a mock.
  let tokenAddr = process.env.PAYMENT_TOKEN?.trim();
  if (!tokenAddr) {
    const mock = await (await ethers.getContractFactory("MockERC20")).deploy();
    await mock.waitForDeployment();
    tokenAddr = await mock.getAddress();
    console.log(`MockERC20:       ${tokenAddr}  (no PAYMENT_TOKEN provided)`);
  } else {
    console.log(`Payment token:   ${tokenAddr}`);
  }

  // 3. AttentionStream
  const stream = await (await ethers.getContractFactory("AttentionStream")).deploy(
    tokenAddr,
    await registry.getAddress(),
    deployer.address, // treasury
    feeBps,
  );
  await stream.waitForDeployment();
  console.log(`AttentionStream: ${await stream.getAddress()}  (fee ${feeBps} bps)`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
