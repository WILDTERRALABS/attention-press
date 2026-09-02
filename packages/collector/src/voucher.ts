import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import type { OnChainSession, VerifyResult, VoucherInput } from "./types.js";

// Mirrors AttentionStream: EIP712("AttentionStream","1") and
// keccak256("Voucher(bytes32 sessionId,uint256 cumulativeAmount)").
export const VOUCHER_TYPES = {
  Voucher: [
    { name: "sessionId", type: "bytes32" },
    { name: "cumulativeAmount", type: "uint256" },
  ],
} as const;

export function voucherDomain(chainId: number, verifyingContract: Address) {
  return { name: "AttentionStream", version: "1", chainId, verifyingContract } as const;
}

export async function recoverVoucherSigner(args: {
  chainId: number;
  streamAddress: Address;
  sessionId: Hex;
  cumulativeAmount: bigint;
  signature: Hex;
}): Promise<Address> {
  return recoverTypedDataAddress({
    domain: voucherDomain(args.chainId, args.streamAddress),
    types: VOUCHER_TYPES,
    primaryType: "Voucher",
    message: { sessionId: args.sessionId, cumulativeAmount: args.cumulativeAmount },
    signature: args.signature,
  });
}

/**
 * Pure re-implementation of every check `AttentionStream._verify` +
 * `_applySettlement` would apply, so the collector never wastes gas on a
 * voucher the contract would revert.
 */
export async function verifyVoucher(params: {
  voucher: VoucherInput;
  session: OnChainSession;
  blockTimestamp: bigint;
  chainId: number;
  streamAddress: Address;
  maxAccrualWindowSec: bigint;
}): Promise<VerifyResult> {
  const { voucher, session } = params;

  if (!session.open) return { ok: false, code: "conflict", reason: "session is closed" };
  if (voucher.cumulativeAmount < 0n) return { ok: false, code: "bad_request", reason: "negative amount" };
  if (voucher.cumulativeAmount < session.claimed) {
    return { ok: false, code: "conflict", reason: `non-monotonic: ${voucher.cumulativeAmount} < claimed ${session.claimed}` };
  }
  if (voucher.cumulativeAmount > session.budget) {
    return { ok: false, code: "conflict", reason: `exceeds budget ${session.budget}` };
  }

  const endCap = session.startTime + params.maxAccrualWindowSec;
  const nowTs = params.blockTimestamp < endCap ? params.blockTimestamp : endCap;
  const elapsed = nowTs > session.startTime ? nowTs - session.startTime : 0n;
  const rateCap = session.ratePerSec * (elapsed + 1n);
  if (voucher.cumulativeAmount > rateCap) {
    return { ok: false, code: "conflict", reason: `exceeds rate cap ${rateCap}` };
  }

  let signer: Address;
  try {
    signer = await recoverVoucherSigner({
      chainId: params.chainId,
      streamAddress: params.streamAddress,
      sessionId: voucher.sessionId,
      cumulativeAmount: voucher.cumulativeAmount,
      signature: voucher.signature,
    });
  } catch {
    return { ok: false, code: "bad_request", reason: "malformed signature" };
  }
  if (signer.toLowerCase() !== session.signer.toLowerCase()) {
    return { ok: false, code: "conflict", reason: "signature is not from the session signer" };
  }

  return { ok: true };
}
