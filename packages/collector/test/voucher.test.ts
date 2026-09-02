import { describe, it, expect } from "vitest";
import { verifyVoucher } from "../src/voucher.js";
import { CHAIN_ID, MAX_ACCRUAL_WINDOW, STREAM, makeSession, newAccount, sid, signVoucher } from "./helpers.js";

const base = {
  blockTimestamp: 2_000_000n,
  chainId: CHAIN_ID,
  streamAddress: STREAM,
  maxAccrualWindowSec: MAX_ACCRUAL_WINDOW,
};

describe("verifyVoucher", () => {
  it("accepts a well-formed voucher signed by the session signer", async () => {
    const signer = newAccount();
    const session = makeSession({ signer: signer.address, startTime: 1_999_990n, ratePerSec: 1_000n });
    const cumulativeAmount = 5_000n; // 5s * 1000, well under rate cap (~10s elapsed)
    const signature = await signVoucher(signer, sid(), cumulativeAmount);

    const res = await verifyVoucher({ ...base, session, voucher: { sessionId: sid(), cumulativeAmount, signature } });
    expect(res).toEqual({ ok: true });
  });

  it("rejects a closed session", async () => {
    const signer = newAccount();
    const session = makeSession({ signer: signer.address, open: false });
    const signature = await signVoucher(signer, sid(), 1_000n);
    const res = await verifyVoucher({ ...base, session, voucher: { sessionId: sid(), cumulativeAmount: 1_000n, signature } });
    expect(res).toMatchObject({ ok: false, code: "conflict" });
  });

  it("rejects a non-monotonic amount", async () => {
    const signer = newAccount();
    const session = makeSession({ signer: signer.address, claimed: 10_000n, startTime: 1_900_000n });
    const signature = await signVoucher(signer, sid(), 9_000n);
    const res = await verifyVoucher({ ...base, session, voucher: { sessionId: sid(), cumulativeAmount: 9_000n, signature } });
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining("non-monotonic") });
  });

  it("rejects amounts over budget", async () => {
    const signer = newAccount();
    const session = makeSession({ signer: signer.address, budget: 4_000n, startTime: 1_900_000n });
    const signature = await signVoucher(signer, sid(), 5_000n);
    const res = await verifyVoucher({ ...base, session, voucher: { sessionId: sid(), cumulativeAmount: 5_000n, signature } });
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining("budget") });
  });

  it("rejects amounts over the rate cap ratePerSec*(elapsed+1)", async () => {
    const signer = newAccount();
    // elapsed = 5s -> cap = 1000 * 6 = 6000
    const session = makeSession({ signer: signer.address, startTime: 1_999_995n, ratePerSec: 1_000n, budget: 10_000_000n });
    const signature = await signVoucher(signer, sid(), 8_000n);
    const res = await verifyVoucher({ ...base, session, voucher: { sessionId: sid(), cumulativeAmount: 8_000n, signature } });
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining("rate cap") });
  });

  it("rejects a signature from the wrong key", async () => {
    const realSigner = newAccount();
    const attacker = newAccount();
    const session = makeSession({ signer: realSigner.address, startTime: 1_900_000n });
    const signature = await signVoucher(attacker, sid(), 1_000n);
    const res = await verifyVoucher({ ...base, session, voucher: { sessionId: sid(), cumulativeAmount: 1_000n, signature } });
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining("session signer") });
  });

  it("rejects a malformed signature", async () => {
    const session = makeSession({ startTime: 1_900_000n });
    const res = await verifyVoucher({
      ...base,
      session,
      voucher: { sessionId: sid(), cumulativeAmount: 1_000n, signature: `0x${"00".repeat(65)}` },
    });
    expect(res).toMatchObject({ ok: false, code: "bad_request" });
  });

  it("rejects a signature bound to a different chain id", async () => {
    const signer = newAccount();
    const session = makeSession({ signer: signer.address, startTime: 1_900_000n });
    const signature = await signVoucher(signer, sid(), 1_000n, { chainId: 999 });
    const res = await verifyVoucher({ ...base, session, voucher: { sessionId: sid(), cumulativeAmount: 1_000n, signature } });
    expect(res).toMatchObject({ ok: false });
  });
});
