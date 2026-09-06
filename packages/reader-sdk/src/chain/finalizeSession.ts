import { decodeEventLog, type Address, type Hex } from "viem";
import { attentionStreamAbi } from "./abi.js";
import { makeClients, requireAccount } from "./client.js";
import type { Eip1193Provider } from "../types.js";

export interface FinalizeSessionParams {
  provider: Eip1193Provider;
  chainId: number;
  contractAddress: Address;
  sessionId: Hex;
}

export interface FinalizeSessionResult {
  txHash: Hex;
  /** `budget - claimed` returned to the reader, from the `SessionClosed` event. */
  refunded: bigint;
}

export type FinalizeSessionFn = (params: FinalizeSessionParams) => Promise<FinalizeSessionResult>;

/**
 * Phase 2: after `closeInitiatedAt + challengeWindow`, refund `budget - claimed`
 * to the reader and close the channel. Permissionless on-chain; the SDK sends it
 * from the reader's wallet. Reverts `ChallengeWindowOpen` if called too early.
 */
export const finalizeSession: FinalizeSessionFn = async (params) => {
  const { publicClient, walletClient } = makeClients(params.provider, params.chainId);
  const sender = await requireAccount(walletClient);

  const txHash = await walletClient.writeContract({
    account: sender,
    chain: null,
    address: params.contractAddress,
    abi: attentionStreamAbi,
    functionName: "finalizeSession",
    args: [params.sessionId],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status === "reverted") {
    throw new Error(`finalizeSession transaction reverted (${txHash})`);
  }

  let refunded = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== params.contractAddress.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: attentionStreamAbi, data: log.data, topics: log.topics });
      if (d.eventName === "SessionClosed") {
        refunded = (d.args as { refunded: bigint }).refunded;
      }
    } catch {
      /* not SessionClosed */
    }
  }
  return { txHash, refunded };
};
