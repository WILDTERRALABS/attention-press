import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";

/**
 * Retire (disable) a list of articles in ArticleRegistry.
 *
 *   IDS=1,2,3,4,5,6,7 npx hardhat run scripts/retire-articles.ts --network monadTestnet
 *
 * `retire(id)` is `onlyAuthor`, so the account behind DEPLOYER_KEY in
 * packages/contracts/.env must be the article's author. Retiring only sets
 * `retired = true` (blocks new reading sessions and hides the article from the
 * frontend); it does not delete anything or touch existing sessions.
 */
async function main() {
  const signer = (await ethers.getSigners())[0];
  if (!signer) throw new Error("No account. Set DEPLOYER_KEY in packages/contracts/.env.");

  const dep = JSON.parse(
    readFileSync(join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"),
  );
  const registry = await ethers.getContractAt("ArticleRegistry", dep.contracts.ArticleRegistry, signer);

  const ids = (process.env.IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => BigInt(s));
  if (ids.length === 0) throw new Error("Pass IDS, e.g. IDS=1,2,3");

  console.log(`Network:  ${network.name}`);
  console.log(`Sender:   ${signer.address}`);
  console.log(`Registry: ${dep.contracts.ArticleRegistry}`);
  console.log(`Retiring: ${ids.join(", ")}\n`);

  for (const id of ids) {
    const a = await registry.articles(id);
    if (a.author === ethers.ZeroAddress) {
      console.log(`#${id}  skip — does not exist`);
      continue;
    }
    if (a.author.toLowerCase() !== signer.address.toLowerCase()) {
      console.log(`#${id}  skip — author is ${a.author}, not this sender`);
      continue;
    }
    if (a.retired) {
      console.log(`#${id}  already retired`);
      continue;
    }
    const tx = await registry.retire(id);
    console.log(`#${id}  retire() -> ${tx.hash}`);
    await tx.wait();
  }
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
