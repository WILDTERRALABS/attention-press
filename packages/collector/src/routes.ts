import type { FastifyInstance } from "fastify";
import { isAddress, isHex, type Address, type Hex } from "viem";
import { UNLOCK_MAX_AGE_MIN, keyRegisterMessage, keyUnlockMessage, recoverSigner } from "./articleKey.js";
import { BIO_MAX_CHARS, verifyBioSignature } from "./profiles.js";
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
    ctx.store.setSessionMeta(sessionId as Hex, {
      author: session.author,
      reader: session.reader,
      articleId: session.articleId,
    });
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

  app.get<{ Params: { address: string } }>("/readers/:address/stats", async (req, reply) => {
    const address = req.params.address;
    if (!isAddress(address)) return reply.code(400).send({ ok: false, reason: "bad address" });
    return ctx.store.readerStats(address as Address);
  });

  app.get<{ Params: { address: string } }>("/profiles/:address", async (req, reply) => {
    const address = req.params.address;
    if (!isAddress(address)) return reply.code(400).send({ ok: false, reason: "bad address" });
    const bio = ctx.store.getBio(address as Address);
    return { address, text: bio.text, updatedAt: bio.updatedAt };
  });

  // Set your own bio. Auth = a wallet signature over
  // `attention-press: set bio for <address>\n\n<text>`.
  app.post("/profiles", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const address = String(body.address ?? "");
    const text = typeof body.text === "string" ? body.text : "";
    const signature = String(body.signature ?? "");

    if (!isAddress(address)) return reply.code(400).send({ ok: false, reason: "bad address" });
    if (text.length > BIO_MAX_CHARS) {
      return reply.code(400).send({ ok: false, reason: `bio must be <= ${BIO_MAX_CHARS} chars` });
    }
    if (!isHex(signature)) return reply.code(400).send({ ok: false, reason: "signature must be hex" });

    const ok = await verifyBioSignature(address as Address, text, signature as Hex);
    if (!ok) return reply.code(401).send({ ok: false, reason: "signature does not match address" });

    const bio = ctx.store.setBio(address as Address, text);
    return reply.code(200).send({ ok: true, address, text: bio.text, updatedAt: bio.updatedAt });
  });

  // ---- encrypted-article key custody ----------------------------------------

  // Author uploads the AES key for an article, keyed by its plaintext contentHash.
  // Verified against the on-chain author only at release time (article may not be
  // published yet). Last write wins.
  app.post("/articles/key", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const contentHash = String(body.contentHash ?? "");
    const key = String(body.key ?? "");
    const signature = String(body.signature ?? "");

    if (!BYTES32.test(contentHash)) return reply.code(400).send({ ok: false, reason: "contentHash must be 32-byte hex" });
    if (key.length !== 44) return reply.code(400).send({ ok: false, reason: "key must be a base64 32-byte value" });
    if (!isHex(signature)) return reply.code(400).send({ ok: false, reason: "signature must be hex" });

    const signer = await recoverSigner(keyRegisterMessage(contentHash as Hex), signature as Hex);
    if (!signer) return reply.code(400).send({ ok: false, reason: "unrecoverable signature" });

    ctx.store.setArticleKey(contentHash as Hex, key, signer);
    return reply.code(200).send({ ok: true, contentHash });
  });

  // Reader releases the key: prove an open session for THIS article.
  app.post<{ Params: { id: string } }>("/articles/:id/key", async (req, reply) => {
    const id = req.params.id;
    if (!/^\d+$/.test(id)) return reply.code(400).send({ ok: false, reason: "bad article id" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const address = String(body.address ?? "");
    const sessionId = String(body.sessionId ?? "");
    const signature = String(body.signature ?? "");
    const timestamp = Number(body.timestamp);

    if (!isAddress(address)) return reply.code(400).send({ ok: false, reason: "bad address" });
    if (!BYTES32.test(sessionId)) return reply.code(400).send({ ok: false, reason: "bad session id" });
    if (!isHex(signature)) return reply.code(400).send({ ok: false, reason: "signature must be hex" });

    const nowMin = Math.floor(Date.now() / 60_000);
    if (!Number.isInteger(timestamp) || Math.abs(nowMin - timestamp) > UNLOCK_MAX_AGE_MIN) {
      return reply.code(401).send({ ok: false, reason: "stale or missing timestamp" });
    }
    const signer = await recoverSigner(keyUnlockMessage(id, address as Address, timestamp), signature as Hex);
    if (!signer || signer.toLowerCase() !== address.toLowerCase()) {
      return reply.code(401).send({ ok: false, reason: "signature does not match address" });
    }

    const session = await ctx.chain.getSession(sessionId as Hex);
    if (!session) return reply.code(403).send({ ok: false, reason: "unknown session" });
    if (!session.open) return reply.code(403).send({ ok: false, reason: "session is closed" });
    if (session.reader.toLowerCase() !== address.toLowerCase()) {
      return reply.code(403).send({ ok: false, reason: "not the session reader" });
    }
    if (session.articleId !== BigInt(id)) {
      return reply.code(403).send({ ok: false, reason: "session is for a different article" });
    }

    const article = await ctx.chain.getArticle(BigInt(id));
    if (!article) return reply.code(404).send({ ok: false, reason: "unknown article" });

    const rec = ctx.store.getArticleKey(article.contentHash);
    if (!rec) return reply.code(404).send({ ok: false, reason: "no key registered for this article" });
    if (rec.claimedAuthor.toLowerCase() !== article.author.toLowerCase()) {
      return reply.code(409).send({ ok: false, reason: "registered key is not from the article author" });
    }

    return reply.code(200).send({ ok: true, key: rec.key });
  });
}
