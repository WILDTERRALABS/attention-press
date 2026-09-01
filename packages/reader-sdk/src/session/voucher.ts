import type { Address, Hex, TypedDataDomain } from "viem";

/**
 * EIP-712 typed-data definition for an `AttentionStream` payment voucher.
 * Mirrors `VOUCHER_TYPEHASH` and `EIP712("AttentionStream", "1")` in the contract:
 *
 *   keccak256("Voucher(bytes32 sessionId,uint256 cumulativeAmount)")
 *
 * `test/voucher.test.ts` asserts the digest this produces is byte-identical to
 * what `AttentionStream._verify` computes on-chain.
 */
export const VOUCHER_TYPES = {
  Voucher: [
    { name: "sessionId", type: "bytes32" },
    { name: "cumulativeAmount", type: "uint256" },
  ],
} as const;

export const VOUCHER_PRIMARY_TYPE = "Voucher" as const;

export const EIP712_DOMAIN_NAME = "AttentionStream" as const;
export const EIP712_DOMAIN_VERSION = "1" as const;

export interface VoucherMessage {
  sessionId: Hex;
  cumulativeAmount: bigint;
}

export function buildDomain(params: { contractAddress: Address; chainId: number }): TypedDataDomain {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId: params.chainId,
    verifyingContract: params.contractAddress,
  };
}

export function buildTypedData(args: {
  contractAddress: Address;
  chainId: number;
  message: VoucherMessage;
}) {
  return {
    domain: buildDomain(args),
    types: VOUCHER_TYPES,
    primaryType: VOUCHER_PRIMARY_TYPE,
    message: args.message,
  } as const;
}
