import { ethers, network } from "hardhat";

// Preflight: show which address DEPLOYER_KEY resolves to and its balance,
// without deploying anything. Never prints the key.
async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No DEPLOYER_KEY set in packages/contracts/.env (0x-prefixed, 64 hex chars).");
  }
  const net = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Network: ${network.name} (chainId ${net.chainId})`);
  console.log(`Address: ${deployer.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} MON`);
  if (balance === 0n) {
    console.log(`\nFund this address at https://faucet.monad.xyz before deploying.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
