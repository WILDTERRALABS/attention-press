import {
  createPublicClient,
  createWalletClient,
  custom,
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { Eip1193Provider } from "../types.js";

/** A bare chain object — the `custom` transport ignores `rpcUrls`. */
export function makeChain(chainId: number): Chain {
  return {
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [] } },
  };
}

export function makeClients(
  provider: Eip1193Provider,
  chainId: number,
): { chain: Chain; publicClient: PublicClient; walletClient: WalletClient } {
  const chain = makeChain(chainId);
  const transport = custom(provider as Parameters<typeof custom>[0]);
  return {
    chain,
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ chain, transport }),
  };
}

export async function requireAccount(walletClient: WalletClient): Promise<Address> {
  const [account] = await walletClient.requestAddresses();
  if (!account) throw new Error("No wallet account available (user rejected or wallet locked)");
  return account;
}
