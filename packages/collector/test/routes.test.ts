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

describe("GET /readers/:address/stats", () => {
  it("400s on a bad address", async () => {
    const res = await app.inject({ method: "GET", url: "/readers/nope/stats" });
    expect(res.statusCode).toBe(400);
  });

  it("aggregates sessions the reader paid for", async () => {
    const signer = newAccount();
    const reader = "0x1111111111111111111111111111111111111111";
    const s = makeSession({
      signer: signer.address,
      reader,
      articleId: 7n,
      startTime: chain.ts - 100n,
      ratePerSec: 1_000n,
      budget: 10_000_000n,
    });
    chain.sessions.set(sid(), s);
    const signature = await signVoucher(signer, sid(), 4_000n);
    await app.inject({ method: "POST", url: "/vouchers", payload: { sessionId: sid(), cumulativeAmount: "4000", signature } });

    const res = await app.inject({ method: "GET", url: `/readers/${reader}/stats` });
    expect(res.json()).toMatchObject({ totalPaid: "4000", sessionsOpened: 1, articlesRead: 1 });
  });
});

describe("GET /articles/:id/replies", () => {
  const mkReply = (index: number, over: Record<string, unknown> = {}) => ({
    articleId: "9",
    index,
    actor: "0x5555555555555555555555555555555555555555" as const,
    text: `reply ${index}`,
    toAuthor: "1950000000000000000",
    fee: "50000000000000000",
    blockNumber: 100 + index,
    blockTime: 1_788_000_000 + index,
    txHash: ("0x" + "ab".repeat(32)) as `0x${string}`,
    ...over,
  });

  it("returns indexed replies chronologically with a total", async () => {
    for (let i = 0; i < 3; i++) store.addReply(mkReply(i));
    const res = await app.inject({ method: "GET", url: "/articles/9/replies" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ articleId: "9", order: "asc", total: 3, nextCursor: null });
    expect(body.replies.map((r: { text: string }) => r.text)).toEqual(["reply 0", "reply 1", "reply 2"]);
    expect(body.replies[0]).toMatchObject({ index: 0, actor: mkReply(0).actor, blockTime: 1_788_000_000 });
  });

  it("reverses with ?order=desc", async () => {
    for (let i = 0; i < 3; i++) store.addReply(mkReply(i));
    const res = await app.inject({ method: "GET", url: "/articles/9/replies?order=desc" });
    expect(res.json().replies.map((r: { text: string }) => r.text)).toEqual(["reply 2", "reply 1", "reply 0"]);
  });

  it("paginates with cursor + limit and reports nextCursor", async () => {
    for (let i = 0; i < 5; i++) store.addReply(mkReply(i));
    const p1 = (await app.inject({ method: "GET", url: "/articles/9/replies?limit=2" })).json();
    expect(p1.replies).toHaveLength(2);
    expect(p1.nextCursor).toBe(2);
    const p2 = (await app.inject({ method: "GET", url: `/articles/9/replies?limit=2&cursor=${p1.nextCursor}` })).json();
    expect(p2.replies.map((r: { text: string }) => r.text)).toEqual(["reply 2", "reply 3"]);
    const p3 = (await app.inject({ method: "GET", url: "/articles/9/replies?limit=2&cursor=4" })).json();
    expect(p3.replies).toHaveLength(1);
    expect(p3.nextCursor).toBeNull();
  });

  it("returns an empty list for an article with no indexed replies", async () => {
    const res = await app.inject({ method: "GET", url: "/articles/12345/replies" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 0, replies: [], nextCursor: null });
  });

  it("400s on a bad id, bad order, or out-of-range limit", async () => {
    expect((await app.inject({ method: "GET", url: "/articles/abc/replies" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/articles/9/replies?order=sideways" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/articles/9/replies?limit=0" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/articles/9/replies?limit=500" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/articles/9/replies?cursor=-1" })).statusCode).toBe(400);
  });
});

describe("profiles / bio", () => {
  it("stores a bio with a valid wallet signature and reads it back", async () => {
    const acct = newAccount();
    const text = "writes about slow reading";
    const signature = await acct.signMessage!({
      message: `attention-press: set bio for ${acct.address.toLowerCase()}\n\n${text}`,
    });

    const post = await app.inject({
      method: "POST",
      url: "/profiles",
      payload: { address: acct.address, text, signature },
    });
    expect(post.statusCode).toBe(200);
    expect(post.json()).toMatchObject({ ok: true, text });

    const get = await app.inject({ method: "GET", url: `/profiles/${acct.address}` });
    expect(get.json()).toMatchObject({ address: acct.address, text });
    expect(get.json().updatedAt).toBeGreaterThan(0);
  });

  it("401s when the signature is from a different key", async () => {
    const owner = newAccount();
    const attacker = newAccount();
    const text = "not mine to set";
    const signature = await attacker.signMessage!({
      message: `attention-press: set bio for ${owner.address.toLowerCase()}\n\n${text}`,
    });
    const res = await app.inject({
      method: "POST",
      url: "/profiles",
      payload: { address: owner.address, text, signature },
    });
    expect(res.statusCode).toBe(401);
  });

  it("400s a bio over 280 chars", async () => {
    const acct = newAccount();
    const text = "x".repeat(281);
    const signature = await acct.signMessage!({
      message: `attention-press: set bio for ${acct.address.toLowerCase()}\n\n${text}`,
    });
    const res = await app.inject({
      method: "POST",
      url: "/profiles",
      payload: { address: acct.address, text, signature },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns an empty bio for an address that never set one", async () => {
    const res = await app.inject({ method: "GET", url: "/profiles/0x2222222222222222222222222222222222222222" });
    expect(res.json()).toMatchObject({ text: "", updatedAt: 0 });
  });

  it("batch-returns bios by address list, empty for unset", async () => {
    const a = newAccount();
    const text = "batch me";
    const sig = await a.signMessage!({
      message: `attention-press: set bio for ${a.address.toLowerCase()}\n\n${text}`,
    });
    await app.inject({ method: "POST", url: "/profiles", payload: { address: a.address, text, signature: sig } });

    const other = "0x2222222222222222222222222222222222222222";
    const res = await app.inject({ method: "GET", url: `/profiles?addresses=${a.address},${other}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body[a.address.toLowerCase()].text).toBe("batch me");
    expect(body[other.toLowerCase()]).toEqual({ text: "", updatedAt: 0 });
  });

  it("400s the batch endpoint on an empty or invalid list", async () => {
    expect((await app.inject({ method: "GET", url: "/profiles" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/profiles?addresses=nope" })).statusCode).toBe(400);
  });
});

describe("encrypted-article keys", () => {
  const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 44 chars -> 32 bytes
  const CONTENT_HASH = ("0x" + "cc".repeat(32)) as `0x${string}`;

  async function registerKey(author: ReturnType<typeof newAccount>, contentHash = CONTENT_HASH) {
    const signature = await author.signMessage!({
      message: `attention-press: register key for ${contentHash.toLowerCase()}`,
    });
    return app.inject({ method: "POST", url: "/articles/key", payload: { contentHash, key: KEY, signature } });
  }

  // Signed by the session's registered ephemeral key (`sessions(id).signer`),
  // not the reader's wallet — proof of possession, no wallet signature.
  async function releaseKey(signer: ReturnType<typeof newAccount>, id: string, sessionId: string, tsOverride?: number) {
    const ts = tsOverride ?? Math.floor(Date.now() / 60_000);
    const signature = await signer.signMessage!({
      message: `attention-press: unlock article ${id} for session ${sessionId.toLowerCase()} at ${ts}`,
    });
    return app.inject({
      method: "POST",
      url: `/articles/${id}/key`,
      payload: { sessionId, signature, timestamp: ts },
    });
  }

  it("registers a key with an author signature", async () => {
    const res = await registerKey(newAccount());
    expect(res.statusCode).toBe(200);
  });

  it("releases the key for the session's registered signer on the right article", async () => {
    const author = newAccount();
    const signer = newAccount();
    await registerKey(author);
    chain.articles.set("7", { author: author.address, contentHash: CONTENT_HASH, retired: false });
    chain.sessions.set(sid(), makeSession({ signer: signer.address, articleId: 7n, open: true }));

    const res = await releaseKey(signer, "7", sid());
    expect(res.statusCode).toBe(200);
    expect(res.json().key).toBe(KEY);
  });

  it("403s when the session is closed", async () => {
    const author = newAccount();
    const signer = newAccount();
    await registerKey(author);
    chain.articles.set("7", { author: author.address, contentHash: CONTENT_HASH, retired: false });
    chain.sessions.set(sid(), makeSession({ signer: signer.address, articleId: 7n, open: false }));
    expect((await releaseKey(signer, "7", sid())).statusCode).toBe(403);
  });

  it("403s when the session is for a different article", async () => {
    const author = newAccount();
    const signer = newAccount();
    await registerKey(author);
    chain.articles.set("7", { author: author.address, contentHash: CONTENT_HASH, retired: false });
    chain.sessions.set(sid(), makeSession({ signer: signer.address, articleId: 99n, open: true }));
    expect((await releaseKey(signer, "7", sid())).statusCode).toBe(403);
  });

  it("401s when the signature isn't from the session's registered signer", async () => {
    const author = newAccount();
    const signer = newAccount();
    const attacker = newAccount();
    await registerKey(author);
    chain.articles.set("7", { author: author.address, contentHash: CONTENT_HASH, retired: false });
    chain.sessions.set(sid(), makeSession({ signer: signer.address, articleId: 7n, open: true }));
    expect((await releaseKey(attacker, "7", sid())).statusCode).toBe(401);
  });

  it("409s when the registered key's author != the on-chain author", async () => {
    const notAuthor = newAccount();
    const realAuthor = newAccount();
    const signer = newAccount();
    await registerKey(notAuthor); // squatter registered the key
    chain.articles.set("7", { author: realAuthor.address, contentHash: CONTENT_HASH, retired: false });
    chain.sessions.set(sid(), makeSession({ signer: signer.address, articleId: 7n, open: true }));
    expect((await releaseKey(signer, "7", sid())).statusCode).toBe(409);
  });

  it("404s when no key was registered", async () => {
    const author = newAccount();
    const signer = newAccount();
    chain.articles.set("7", { author: author.address, contentHash: CONTENT_HASH, retired: false });
    chain.sessions.set(sid(), makeSession({ signer: signer.address, articleId: 7n, open: true }));
    expect((await releaseKey(signer, "7", sid())).statusCode).toBe(404);
  });

  it("401s on a stale timestamp", async () => {
    const author = newAccount();
    const signer = newAccount();
    await registerKey(author);
    chain.articles.set("7", { author: author.address, contentHash: CONTENT_HASH, retired: false });
    chain.sessions.set(sid(), makeSession({ signer: signer.address, articleId: 7n, open: true }));
    const staleTs = Math.floor(Date.now() / 60_000) - 10;
    expect((await releaseKey(signer, "7", sid(), staleTs)).statusCode).toBe(401);
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
