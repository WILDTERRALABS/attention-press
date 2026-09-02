import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { monadTestnet, RPC_URL } from "./chain";

export const wagmiConfig = createConfig({
  chains: [monadTestnet],
  connectors: [injected()],
  transports: { [monadTestnet.id]: http(RPC_URL) },
  ssr: false,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
