import { describe, expect, it } from "vitest";
import { decryptBody, encryptBody, isKeyB64, randomKeyB64 } from "../src/lib/crypto";

describe("crypto", () => {
  it("round-trips a body through AES-GCM", async () => {
    const key = randomKeyB64();
    const body = "# Title\n\nSome *markdown* with unicode ✒️ and\nnewlines.";
    const enc = await encryptBody(body, key);
    expect(enc.alg).toBe("AES-GCM");
    expect(await decryptBody(enc, key)).toBe(body);
  });

  it("generates 32-byte keys", () => {
    const k = randomKeyB64();
    expect(isKeyB64(k)).toBe(true);
    expect(isKeyB64("too short")).toBe(false);
    expect(randomKeyB64()).not.toBe(randomKeyB64());
  });

  it("rejects decryption with the wrong key", async () => {
    const enc = await encryptBody("secret", randomKeyB64());
    await expect(decryptBody(enc, randomKeyB64())).rejects.toBeTruthy();
  });

  it("rejects a tampered ciphertext (GCM auth tag)", async () => {
    const key = randomKeyB64();
    const enc = await encryptBody("secret", key);
    const bytes = atob(enc.ct).split("");
    bytes[0] = String.fromCharCode(bytes[0]!.charCodeAt(0) ^ 0xff);
    await expect(decryptBody({ ...enc, ct: btoa(bytes.join("")) }, key)).rejects.toBeTruthy();
  });
});
