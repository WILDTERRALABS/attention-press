import type { FastifyInstance } from "fastify";
import { isAddress, isHex, type Address, type Hex } from "viem";
import { verifyVoucher } from "./voucher.js";
import type { ServerContext } from "./types.js";

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const bigMax = (a: bigint, b: bigint): bigint => (a > b ? a : b);

export function registerRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/health", async () => {
    let blockTimestamp: string | null = null;
    let status = "ok";
    try {
      blockTimestamp = (await ctx.chain.latestBlockTimestamp()).toString();
    } catch {
      status = "degraded";
    }
    return {
      status,
      chainId: ctx.chain.chainId,
      streamAddress: ctx.chain.streamAddress,
      settler: ctx.chain.settlerAddress,
      blockTimestamp,
    };
  });

  app.get("/metrics", async () => ({ ...ctx.store.metrics }));

  app.post("/vouchers", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = String(body.sessionId ?? "");
    const signature = String(body.signature ?? "");

    if (!BYTES32.test(sessionId)) {
      return reply.code(400).send({ ok: false, reason: "sessionId must be 32-byte hex" });
    }
    if (!isHex(signature) || signature.length !== 132) {
      return reply.code(400).send({ ok: false, reason: "signature must be 65-byte hex" });
    }
    let cumulativeAmount: bigint;
    try {
      const raw = body.cumulativeAmount;
      cumulativeAmount = BigInt(typeof raw === "number" ? Math.trunc(raw) : String(raw));
    } catch {
      return reply.code(400).send({ ok: false, reason: "cumulativeAmount must be an integer" });
    }
    if (cumulativeAmount < 0n) {
      return reply.code(400).send({ ok: false, reason: "cumulativeAmount must be >= 0" });
    }

    ctx.store.metrics.vouchersReceived++;

    const session = await ctx.chain.getSession(sessionId as Hex);
    if (!session) {
      ctx.store.metrics.vouchersRejected++;
      return reply.code(404).send({ ok: false, reason: "unknown session" });
    }

    const blockTimestamp = await ctx.chain.latestBlockTimestamp();
    const res = await verifyVoucher({
      voucher: { sessionId: sessionId as Hex, cumulativeAmount, signature: signature as Hex },
      session,
      blockTimestamp,
      chainId: ctx.chain.chainId,
      streamAddress: ctx.chain.streamAddress,
      maxAccrualWindowSec: ctx.maxAccrualWindowSec,
    });
    if (!res.ok) {
      ctx.store.metrics.vouchersRejected++;
      return reply.code(res.code === "bad_request" ? 400 : 409).send({ ok: false, reason: res.reason });
    }

    ctx.store.putVoucher({ sessionId: sessionId as Hex, cumulativeAmount, signature: signature as Hex });
    ctx.store.setAuthor(sessionId as Hex, session.author);
    ctx.store.metrics.vouchersAccepted++;
    return reply.code(202).send({ ok: true, sessionId, cumulativeAmount: cumulativeAmount.toString() });
  });

  app.get<{ Params: { id: string } }>("/sessions/:id", async (req, reply) => {
    const id = req.params.id;
    if (!BYTES32.test(id)) return reply.code(400).send({ ok: false, reason: "bad session id" });

    const session = await ctx.chain.getSession(id as Hex);
    const rec = ctx.store.get(id);
    if (!session && !rec) return reply.code(404).send({ ok: false, reason: "unknown session" });

    const latest = rec?.latest ?? null;
    const claimed = session?.claimed ?? 0n;
    return {
      sessionId: id,
      onChain: session
        ? {
            reader: session.reader,
            signer: session.signer,
            author: session.author,
            budget: session.budget.toString(),
            claimed: session.claimed.toString(),
            articleId: session.articleId.toString(),
            startTime: session.startTime.toString(),
            ratePerSec: session.ratePerSec.toString(),
            open: session.open,
          }
        : null,
      latestVoucher: latest
        ? {
            cumulativeAmount: latest.cumulativeAmount.toString(),
            signature: latest.signature,
            receivedAt: latest.receivedAt,
          }
        : null,
      pendingDelta: (latest ? bigMax(latest.cumulativeAmount - claimed, 0n) : 0n).toString(),
    };
  });

  app.get<{ Params: { address: string } }>("/authors/:address/earnings", async (req, reply) => {
    const address = req.params.address;
    if (!isAddress(address)) return reply.code(400).send({ ok: false, reason: "bad address" });
    return ctx.store.earningsByAuthor(address as Address);
  });
}
