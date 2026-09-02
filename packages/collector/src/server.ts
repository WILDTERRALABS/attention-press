import Fastify, { type FastifyInstance } from "fastify";
import { registerRoutes } from "./routes.js";
import type { ServerContext } from "./types.js";

export function buildServer(ctx: ServerContext, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 16 * 1024 });
  registerRoutes(app, ctx);
  return app;
}
