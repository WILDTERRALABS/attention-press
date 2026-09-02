import { recoverMessageAddress, type Address, type Hex } from "viem";

export const BIO_MAX_CHARS = 280;

/** The message the wallet must sign to authorize a bio write. */
export function bioMessage(address: Address, text: string): string {
  return `attention-press: set bio for ${address.toLowerCase()}\n\n${text}`;
}

/** True iff `signature` over `bioMessage(address, text)` recovers to `address`. */
export async function verifyBioSignature(
  address: Address,
  text: string,
  signature: Hex,
): Promise<boolean> {
  try {
    const recovered = await recoverMessageAddress({ message: bioMessage(address, text), signature });
    return recovered.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}
