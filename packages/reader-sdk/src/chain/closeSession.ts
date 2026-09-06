import type { Address, Hex } from "viem";
import { attentionStreamAbi } from "./abi.js";
import { makeClients, requireAccount } from "./client.js";
import type { Eip1193Provider } from "../types.js";

export interface CloseSessionParams {
  provider: Eip1193Provider;
  chainId: number;
  contractAddress: Address;
  sessionId: Hex;
}

export type CloseSessionFn = (params: CloseSessionParams) => Promise<Hex>;

/**
 * Phase 1 of closing: records the on-chain accrual cutoff and starts the
 * challenge window. Does NOT refund — call `finalizeSession` after the window.
 */
export const closeSession: CloseSessionFn = async (params) => {
  const { publicClient, walletClient } = makeClients(params.provider, params.chainId);
  const reader = await requireAccount(walletClient);

  const txHash = await walletClient.writeContract({
    account: reader,
    chain: null,
    address: params.contractAddress,
    abi: attentionStreamAbi,
    functionName: "closeSession",
    args: [params.sessionId],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status === "reverted") {
    throw new Error(`closeSession transaction reverted (${txHash})`);
  }
  return txHash;
};
