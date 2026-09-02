import { recoverMessageAddress, type Address, type Hex } from "viem";

/** Max age (minutes) of a key-release request signature. */
export const UNLOCK_MAX_AGE_MIN = 5;

/** Signed by the author when uploading a key (before or at publish). */
export function keyRegisterMessage(contentHash: Hex): string {
  return `attention-press: register key for ${contentHash.toLowerCase()}`;
}

/** Signed by the reader to release a key; binds article id, reader, and a minute-timestamp. */
export function keyUnlockMessage(articleId: string, reader: Address, unixMinute: number): string {
  return `attention-press: unlock article ${articleId} for ${reader.toLowerCase()} at ${unixMinute}`;
}

export async function recoverSigner(message: string, signature: Hex): Promise<Address | null> {
  try {
    return await recoverMessageAddress({ message, signature });
  } catch {
    return null;
  }
}
