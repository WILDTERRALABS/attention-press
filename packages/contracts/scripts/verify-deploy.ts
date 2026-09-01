import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";

// Read back the deployment and confirm the wiring on-chain.
async function main() {
  const rec = JSON.parse(
    readFileSync(join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"),
  );
  const { ArticleRegistry, AttentionStream, paymentToken } = rec.contracts;

  for (const [name, addr] of Object.entries({ ArticleRegistry, AttentionStream, paymentToken })) {
    const code = await ethers.provider.getCode(addr as string);
    console.log(`${name.padEnd(16)} ${addr}  code: ${code === "0x" ? "MISSING" : `${(code.length - 2) / 2} bytes`}`);
  }

  const stream = await ethers.getContractAt("AttentionStream", AttentionStream);
  const [token, registry, treasury, feeBps, timeout] = await Promise.all([
    stream.token(),
    stream.registry(),
    stream.treasury(),
    stream.protocolFeeBps(),
    stream.sessionTimeout(),
  ]);

  console.log("\nAttentionStream wiring:");
  console.log(`  token()          ${token}   ${token === paymentToken ? "== paymentToken OK" : "MISMATCH"}`);
  console.log(`  registry()       ${registry}   ${registry === ArticleRegistry ? "== ArticleRegistry OK" : "MISMATCH"}`);
  console.log(`  treasury()       ${treasury}   ${treasury === rec.treasury ? "== deployer OK" : "MISMATCH"}`);
  console.log(`  protocolFeeBps() ${feeBps}   ${Number(feeBps) === rec.protocolFeeBps ? "OK" : "MISMATCH"}`);
  console.log(`  sessionTimeout() ${timeout} s (${Number(timeout) / 86400} d)`);

  const reg = await ethers.getContractAt("ArticleRegistry", ArticleRegistry);
  console.log(`\nArticleRegistry.nextId() ${await reg.nextId()}  (1 = no articles yet)`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
