import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { VoucherStore } from "../src/store.js";
import { FakeChain, MAX_ACCRUAL_WINDOW, makeSession, newAccount, sid, signVoucher } from "./helpers.js";

let app: FastifyInstance;
let chain: FakeChain;
let store: VoucherStore;

beforeEach(() => {
  chain = new FakeChain();
  store = new VoucherStore();
  app = buildServer(
    { chain, store, maxAccrualWindowSec: MAX_ACCRUAL_WINDOW },
    { allowedOrigins: ["http://localhost:3000"] },
  );
});
afterEach(async () => {
  await app.close();
});

describe("POST /vouchers", () => {
  it("accepts a valid voucher and stores it", async () => {
    const signer = newAccount();
    chain.sessions.set(sid(), makeSession({ signer: signer.address, startTime: chain.ts - 20n, ratePerSec: 1_000n }));
    const cumulativeAmount = 5_000n;
    const signature = await signVoucher(signer, sid(), cumulativeAmount);

    const res = await app.inject({
      method: "POST",
      url: "/vouchers",
      payload: { sessionId: sid(), cumulativeAmount: cumulativeAmount.toString(), signature },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ ok: true, cumulativeAmount: "5000" });
    expect(store.get(sid())?.latest?.cumulativeAmount).toBe(5_000n);
    expect(store.get(sid())?.author).toBe(makeSession().author);
    expect(store.metrics.vouchersAccepted).toBe(1);
  });

  it("400s on a malformed body", async () => {
    const res = await app.inject({ method: "POST", url: "/vouchers", payload: { sessionId: "nope", cumulativeAmount: "x", signature: "0x1" } });
    expect(res.statusCode).toBe(400);
  });

  it("404s for an unknown session", async () => {
    const signer = newAccount();
    const signature = await signVoucher(signer, sid(), 1_000n);
    const res = await app.inject({
      method: "POST",
      url: "/vouchers",
      payload: { sessionId: sid(), cumulativeAmount: "1000", signature },
    });
    expect(res.statusCode).toBe(404);
  });

  it("409s on a voucher the contract would reject (over budget)", async () => {
    const signer = newAccount();
    chain.sessions.set(sid(), makeSession({ signer: signer.address, budget: 1_000n, startTime: chain.ts - 100n }));
    const signature = await signVoucher(signer, sid(), 5_000n);
    const res = await app.inject({
      method: "POST",
      url: "/vouchers",
      payload: { sessionId: sid(), cumulativeAmount: "5000", signature },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toContain("budget");
    expect(store.metrics.vouchersRejected).toBe(1);
  });

  it("keeps the higher of two vouchers", async () => {
    const signer = newAccount();
    chain.sessions.set(sid(), makeSession({ signer: signer.address, startTime: chain.ts - 100n, ratePerSec: 1_000n, budget: 10_000_000n }));
    for (const amt of [3_000n, 8_000n, 5_000n]) {
      const signature = await signVoucher(signer, sid(), amt);
      await app.inject({ method: "POST", url: "/vouchers", payload: { sessionId: sid(), cumulativeAmount: amt.toString(), signature } });
    }
    expect(store.get(sid())?.latest?.cumulativeAmount).toBe(8_000n);
  });
});

describe("GET /sessions/:id", () => {
  it("returns on-chain state plus the latest voucher and pending delta", async () => {
    const signer = newAccount();
    chain.sessions.set(sid(), makeSession({ signer: signer.address, claimed: 1_000n, startTime: chain.ts - 100n, ratePerSec: 1_000n, budget: 10_000_000n }));
    const signature = await signVoucher(signer, sid(), 6_000n);
    await app.inject({ method: "POST", url: "/vouchers", payload: { sessionId: sid(), cumulativeAmount: "6000", signature } });

    const res = await app.inject({ method: "GET", url: `/sessions/${sid()}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.onChain.claimed).toBe("1000");
    expect(body.latestVoucher.cumulativeAmount).toBe("6000");
    expect(body.pendingDelta).toBe("5000");
  });

  it("404s for a fully unknown session", async () => {
    const res = await app.inject({ method: "GET", url: `/sessions/${sid("ff")}` });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /authors/:address/earnings", () => {
  it("400s on a bad address", async () => {
    const res = await app.inject({ method: "GET", url: "/authors/not-an-address/earnings" });
    expect(res.statusCode).toBe(400);
  });

  it("returns aggregated totals", async () => {
    const signer = newAccount();
    const s = makeSession({ signer: signer.address, startTime: chain.ts - 100n, ratePerSec: 1_000n, budget: 10_000_000n });
    chain.sessions.set(sid(), s);
    const signature = await signVoucher(signer, sid(), 7_000n);
    await app.inject({ method: "POST", url: "/vouchers", payload: { sessionId: sid(), cumulativeAmount: "7000", signature } });

    const res = await app.inject({ method: "GET", url: `/authors/${s.author}/earnings` });
    expect(res.json()).toMatchObject({ pendingTotal: "7000", settledTotal: "0" });
  });
});

describe("GET /health and /metrics", () => {
  it("health reports chain wiring", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toMatchObject({ status: "ok", chainId: chain.chainId, streamAddress: chain.streamAddress });
  });

  it("health degrades when the RPC is unreachable", async () => {
    chain.blockError = new Error("ECONNREFUSED");
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json().status).toBe("degraded");
  });

  it("metrics echoes counters", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.json()).toHaveProperty("vouchersReceived", 0);
  });
});

describe("CORS", () => {
  it("answers the preflight for an allowed origin", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/vouchers",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("reflects the allow-origin header on an actual POST", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/vouchers",
      headers: { origin: "http://localhost:3000" },
      payload: { sessionId: "bad", cumulativeAmount: "1", signature: "0x1" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });
});
