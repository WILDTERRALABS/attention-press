"use client";

import { useCallback, useMemo } from "react";
import type { Abi, Address } from "viem";
import { usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { ARTICLE_ACTIONS, articleActionsAbi, erc20Abi, WMON } from "./chain";

export type ActionKind = "like" | "dislike" | "favorite";

export interface ActionsState {
  configured: boolean;
  counts: { like: bigint; dislike: bigint; favorite: bigint; reply: bigint; tipped: bigint };
  mine: { like: boolean; dislike: boolean; favorite: boolean };
  allowance: bigint;
  balance: bigint;
  isLoading: boolean;
  refetch: () => void;
}

const spender = ARTICLE_ACTIONS as Address;

/** Reads every counter + the caller's one-shot flags + WMON allowance/balance. */
export function useArticleActions(articleId: bigint, account?: Address): ActionsState {
  const configured = !!ARTICLE_ACTIONS;

  const contracts = useMemo(() => {
    if (!configured) return [];
    const a = { address: spender, abi: articleActionsAbi as Abi } as const;
    const base = [
      { ...a, functionName: "likeCount", args: [articleId] },
      { ...a, functionName: "dislikeCount", args: [articleId] },
      { ...a, functionName: "favoriteCount", args: [articleId] },
      { ...a, functionName: "replyCount", args: [articleId] },
      { ...a, functionName: "totalTipped", args: [articleId] },
    ];
    const perUser = account
      ? [
          { ...a, functionName: "hasLiked", args: [articleId, account] },
          { ...a, functionName: "hasDisliked", args: [articleId, account] },
          { ...a, functionName: "hasFavorited", args: [articleId, account] },
          { address: WMON, abi: erc20Abi as Abi, functionName: "allowance", args: [account, spender] },
          { address: WMON, abi: erc20Abi as Abi, functionName: "balanceOf", args: [account] },
        ]
      : [];
    return [...base, ...perUser];
  }, [configured, articleId, account]);

  const { data, isLoading, refetch } = useReadContracts({
    contracts,
    query: { enabled: contracts.length > 0 },
  });

  const n = (i: number) => (data?.[i]?.result as bigint | undefined) ?? 0n;
  const b = (i: number) => (data?.[i]?.result as boolean | undefined) ?? false;

  return {
    configured,
    counts: { like: n(0), dislike: n(1), favorite: n(2), reply: n(3), tipped: n(4) },
    mine: { like: b(5), dislike: b(6), favorite: b(7) },
    allowance: n(8),
    balance: n(9),
    isLoading,
    refetch: () => void refetch(),
  };
}

/**
 * Approve exactly `amount` WMON to ArticleActions (only if the current allowance
 * is short) then send the action. Two calls at most, both awaited to receipt.
 */
export function useSendAction() {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  return useCallback(
    async (
      call: { functionName: "like" | "dislike" | "favorite" | "reply" | "tip"; args: unknown[] },
      cost: bigint,
      currentAllowance: bigint,
    ) => {
      if (!ARTICLE_ACTIONS) throw new Error("ArticleActions address not configured");
      if (currentAllowance < cost) {
        const approveHash = await writeContractAsync({
          address: WMON,
          abi: erc20Abi,
          functionName: "approve",
          args: [spender, cost],
        });
        await publicClient?.waitForTransactionReceipt({ hash: approveHash });
      }
      const hash = await writeContractAsync({
        address: spender,
        abi: articleActionsAbi,
        functionName: call.functionName,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: call.args as any,
      });
      await publicClient?.waitForTransactionReceipt({ hash });
      return hash;
    },
    [writeContractAsync, publicClient],
  );
}
