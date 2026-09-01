import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config"; // loads packages/contracts/.env

// Monad testnet verified live 2026-09-01: eth_chainId -> 0x279f (10143),
// RPC https://testnet-rpc.monad.xyz producing blocks.
const MONAD_RPC_URL = process.env.MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const DEPLOYER_KEY = process.env.DEPLOYER_KEY;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    monadTestnet: {
      url: MONAD_RPC_URL,
      chainId: 10143,
      accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
    },
  },
};

export default config;
