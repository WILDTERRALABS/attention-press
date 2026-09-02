import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { monadTestnet, RPC_URL } from "./chain";

// The public Monad testnet RPC rate-limits hard. Collapse reads into Multicall3 +
// JSON-RPC batches, don't retry-storm on 429, and poll slowly. For smooth browser
// testing set NEXT_PUBLIC_RPC_URL to a dedicated endpoint (Alchemy/QuickNode).
export const wagmiConfig = createConfig({
  chains: [monadTestnet],
  connectors: [injected()],
  batch: { multicall: { wait: 64, batchSize: 2048 } },
  pollingInterval: 12_000,
  transports: {
    [monadTestnet.id]: http(RPC_URL, { batch: { wait: 32 }, retryCount: 0 }),
  },
  ssr: false,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
