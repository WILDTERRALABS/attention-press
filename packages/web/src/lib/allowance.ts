"use client";

import { useCallback } from "react";
import type { Address } from "viem";
import { usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { erc20Abi, WMON } from "./chain";

export interface StandingAllowance {
  /** Current WMON allowance from the connected wallet to `spender`. */
  allowance: bigint;
  /** allowance >= `min` — the "approve" panel can hide. */
  sufficient: boolean;
  isLoading: boolean;
  /** Approve `standing` WMON to `spender`, wait for the receipt, refetch. One popup. */
  approve: () => Promise<void>;
  refetch: () => void;
}

/**
 * One-time standing WMON approval to a spender (AttentionStream / ArticleActions).
 * Reads the live allowance; `approve()` sets it to `standing` in a single tx.
 */
export function useStandingAllowance(opts: {
  owner?: Address;
  spender: Address;
  standing: bigint;
  min: bigint;
}): StandingAllowance {
  const { owner, spender, standing, min } = opts;
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const read = useReadContract({
    address: WMON,
    abi: erc20Abi,
    functionName: "allowance",
    args: owner ? [owner, spender] : undefined,
    query: { enabled: !!owner },
  });

  const allowance = (read.data as bigint | undefined) ?? 0n;

  const approve = useCallback(async () => {
    const hash = await writeContractAsync({
      address: WMON,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, standing],
    });
    await publicClient?.waitForTransactionReceipt({ hash });
    await read.refetch();
  }, [writeContractAsync, publicClient, spender, standing, read]);

  return {
    allowance,
    sufficient: !!owner && allowance >= min,
    isLoading: read.isLoading,
    approve,
    refetch: () => void read.refetch(),
  };
}
