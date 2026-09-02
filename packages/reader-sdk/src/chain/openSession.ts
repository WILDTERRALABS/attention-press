import { decodeEventLog, zeroAddress, type Address, type Hex } from "viem";
import { attentionStreamAbi, erc20Abi } from "./abi.js";
import { makeClients, requireAccount } from "./client.js";
import type { Eip1193Provider } from "../types.js";

export interface OpenSessionParams {
  provider: Eip1193Provider;
  chainId: number;
  contractAddress: Address;
  articleId: bigint;
  budget: bigint;
  ratePerSec: bigint;
  /** Ephemeral session-key address registered on-chain to sign vouchers. */
  signer: Address;
  paymentToken?: Address;
  skipApproval?: boolean;
}

export interface OpenSessionResult {
  sessionId: Hex;
  txHash: Hex;
  reader: Address;
  author: Address;
}

export type OpenSessionFn = (params: OpenSessionParams) => Promise<OpenSessionResult>;

/** Approve the payment token if needed, send `openSession`, and read back the id. */
export const openSession: OpenSessionFn = async (params) => {
  const { publicClient, walletClient } = makeClients(params.provider, params.chainId);
  const reader = await requireAccount(walletClient);

  if (!params.skipApproval) {
    const token =
      params.paymentToken ??
      ((await publicClient.readContract({
        address: params.contractAddress,
        abi: attentionStreamAbi,
        functionName: "token",
      })) as Address);

    const allowance = (await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [reader, params.contractAddress],
    })) as bigint;

    if (allowance < params.budget) {
      const approveHash = await walletClient.writeContract({
        account: reader,
        chain: null,
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [params.contractAddress, params.budget],
      });
      const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
      if (approveReceipt.status === "reverted") {
        throw new Error(`token approval reverted (${approveHash})`);
      }
    }
  }

  const txHash = await walletClient.writeContract({
    account: reader,
    chain: null,
    address: params.contractAddress,
    abi: attentionStreamAbi,
    functionName: "openSession",
    args: [params.articleId, params.budget, params.ratePerSec, params.signer],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  if (receipt.status === "reverted") {
    throw new Error(
      `openSession transaction reverted (${txHash}). ` +
        `Usual causes: the reader's payment-token balance is below budget, the ` +
        `allowance is insufficient, or the article is retired.`,
    );
  }

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== params.contractAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: attentionStreamAbi, data: log.data, topics: log.topics });
      if (decoded.eventName === "SessionOpened") {
        const args = decoded.args as { id: Hex; author: Address };
        return { sessionId: args.id, txHash, reader, author: args.author ?? zeroAddress };
      }
    } catch {
      /* not a SessionOpened log */
    }
  }
  throw new Error("openSession: SessionOpened event not found in transaction receipt");
};
