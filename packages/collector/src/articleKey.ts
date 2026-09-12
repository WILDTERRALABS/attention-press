import { recoverMessageAddress, type Address, type Hex } from "viem";

/** Max age (minutes) of a key-release request signature. */
export const UNLOCK_MAX_AGE_MIN = 5;

/** Signed by the author when uploading a key (before or at publish). */
export function keyRegisterMessage(contentHash: Hex): string {
  return `attention-press: register key for ${contentHash.toLowerCase()}`;
}

/**
 * Signed by the session's ephemeral key (not the reader's wallet) to release a
 * key; binds article id, the specific open session, and a minute-timestamp.
 * Verified against that session's on-chain `signer` — proof of possession of
 * the same key that already signs vouchers, no wallet popup required.
 */
export function keyUnlockMessage(articleId: string, sessionId: Hex, unixMinute: number): string {
  return `attention-press: unlock article ${articleId} for session ${sessionId.toLowerCase()} at ${unixMinute}`;
}

export async function recoverSigner(message: string, signature: Hex): Promise<Address | null> {
  try {
    return await recoverMessageAddress({ message, signature });
  } catch {
    return null;
  }
}
