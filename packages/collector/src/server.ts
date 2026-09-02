import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { registerRoutes } from "./routes.js";
import type { ServerContext } from "./types.js";

export function buildServer(
  ctx: ServerContext,
  opts: { logger?: boolean; allowedOrigins?: string[] } = {},
): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 16 * 1024 });

  // Browsers preflight cross-origin POSTs (the web app on :3000 -> collector on
  // :8787). Without this the OPTIONS 404s and the fetch fails with "Failed to
  // fetch". `true` reflects any origin when none are configured (dev/tests).
  const origins = opts.allowedOrigins?.length ? opts.allowedOrigins : true;
  void app.register(cors, { origin: origins, methods: ["GET", "POST"] });

  registerRoutes(app, ctx);
  return app;
}
