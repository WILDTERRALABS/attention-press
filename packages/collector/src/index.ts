import "dotenv/config";
import { ViemChainAdapter } from "./chain.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { SettleLoop } from "./settleLoop.js";
import { VoucherStore } from "./store.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const chain = new ViemChainAdapter(config);
  const store = new VoucherStore(config.dataDir);

  const app = buildServer({ chain, store, maxAccrualWindowSec: config.maxAccrualWindowSec }, { logger: true });
  const loop = new SettleLoop(chain, store, {
    intervalMs: config.settleIntervalMs,
    minDelta: config.minSettleDelta,
    log: (msg, extra) => app.log.info({ extra }, `[settle] ${msg}`),
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  loop.start();
  app.log.info(
    `collector listening on :${config.port} — chain ${config.chainId}, stream ${config.streamAddress}, settler ${chain.settlerAddress}`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${signal} received, shutting down`);
    loop.stop();
    store.snapshot();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
