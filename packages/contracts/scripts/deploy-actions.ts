import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";

/**
 * Deploy ArticleActions (like / dislike / favorite / reply / tip) against the
 * ALREADY-deployed ArticleRegistry + payment token recorded in
 * deployments/<network>.json. Leaves deploy.ts and every existing contract
 * untouched; only adds `contracts.ArticleActions` to the deployment record.
 *
 *   npx hardhat run scripts/deploy-actions.ts --network monadTestnet
 *
 * Env (packages/contracts/.env):
 *   ACTION_FEE_BPS   optional, default = recorded protocolFeeBps (else 250). Max 1000.
 *   ACTIONS_TREASURY optional, default = recorded treasury (else deployer).
 */
async function main() {
  const deployer = (await ethers.getSigners())[0];
  if (!deployer) throw new Error("No deployer. Set DEPLOYER_KEY in packages/contracts/.env.");

  const net = await ethers.provider.getNetwork();
  const outFile = join(__dirname, "..", "deployments", `${network.name}.json`);
  const record = JSON.parse(readFileSync(outFile, "utf8"));

  const registryAddr: string = record.contracts?.ArticleRegistry;
  const tokenAddr: string = record.contracts?.paymentToken;
  if (!registryAddr || !tokenAddr) {
    throw new Error(`${outFile} is missing contracts.ArticleRegistry / contracts.paymentToken — run deploy.ts first.`);
  }
  for (const [label, addr] of [
    ["ArticleRegistry", registryAddr],
    ["paymentToken", tokenAddr],
  ] as const) {
    if ((await ethers.provider.getCode(addr)) === "0x") {
      throw new Error(`${label} ${addr} has no code on ${network.name}`);
    }
  }

  const treasury = (process.env.ACTIONS_TREASURY?.trim() || record.treasury || deployer.address) as string;
  const feeBps = Number(process.env.ACTION_FEE_BPS ?? record.protocolFeeBps ?? 250);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) {
    throw new Error(`ACTION_FEE_BPS must be an integer 0..1000 (got ${feeBps})`);
  }

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Network:  ${network.name} (chainId ${net.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(balance)} MON`);
  if (balance === 0n) {
    console.error(`\nDeployer has no balance. Fund it and re-run.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Registry: ${registryAddr}`);
  console.log(`Token:    ${tokenAddr}`);
  console.log(`Treasury: ${treasury}`);
  console.log(`Fee:      ${feeBps} bps\n`);

  if (record.contracts.ArticleActions) {
    console.log(`Note: replacing existing ArticleActions ${record.contracts.ArticleActions} in the record.`);
  }

  const actions = await (await ethers.getContractFactory("ArticleActions")).deploy(
    tokenAddr,
    registryAddr,
    treasury,
    feeBps,
  );
  await actions.waitForDeployment();
  const actionsAddr = await actions.getAddress();
  console.log(`ArticleActions: ${actionsAddr}`);

  record.contracts.ArticleActions = actionsAddr;
  record.actionFeeBps = feeBps;
  record.actionsTreasury = treasury;
  record.actionsDeployedAt = new Date().toISOString();
  writeFileSync(outFile, JSON.stringify(record, null, 2) + "\n");
  console.log(`\nUpdated ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
