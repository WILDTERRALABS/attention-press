import type { Address, Hex } from "viem";
import { attentionStreamAbi } from "./abi.js";
import { makeClients, requireAccount } from "./client.js";
import type { Eip1193Provider } from "../types.js";

export interface CloseSessionParams {
  provider: Eip1193Provider;
  chainId: number;
  contractAddress: Address;
  sessionId: Hex;
  /** Latest voucher total, or `0n` with `sig = "0x"` to settle nothing. */
  cumulativeAmount: bigint;
  signature: Hex;
}

export type CloseSessionFn = (params: CloseSessionParams) => Promise<Hex>;

/** Send `closeSession` from the reader's wallet; refunds unspent budget on-chain. */
export const closeSession: CloseSessionFn = async (params) => {
  const { publicClient, walletClient } = makeClients(params.provider, params.chainId);
  const reader = await requireAccount(walletClient);

  const txHash = await walletClient.writeContract({
    account: reader,
    chain: null,
    address: params.contractAddress,
    abi: attentionStreamAbi,
    functionName: "closeSession",
    args: [params.sessionId, params.cumulativeAmount, params.signature],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status === "reverted") {
    throw new Error(`closeSession transaction reverted (${txHash})`);
  }
  return txHash;
};
