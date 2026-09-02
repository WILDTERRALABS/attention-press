import { ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";

async function main() {
  const dep = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "monadTestnet.json"), "utf8"),
  );
  const reg = await ethers.getContractAt("ArticleRegistry", dep.contracts.ArticleRegistry);
  const next = await reg.nextId();
  console.log(`ArticleRegistry ${dep.contracts.ArticleRegistry}  nextId=${next}`);
  for (let id = 1n; id < next; id++) {
    const a = await reg.articles(id);
    const uri: string = await reg.metadataURI(id);
    let title = "(non-inline metadata)";
    const m = uri.match(/^data:application\/json;base64,(.*)$/);
    if (m) {
      try {
        title = JSON.parse(Buffer.from(m[1], "base64").toString("utf8")).title ?? "(no title)";
      } catch {
        title = "(unparseable)";
      }
    }
    console.log(
      `#${id}  author=${a.author}  retired=${a.retired}  createdAt=${new Date(Number(a.createdAt) * 1000).toISOString()}  title=${JSON.stringify(title)}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
