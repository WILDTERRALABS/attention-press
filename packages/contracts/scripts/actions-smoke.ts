import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";
import type {
  Contract as EthersContract,
  ContractTransactionReceipt,
  Interface as EthersInterface,
} from "ethers";

type ParsableLog = { topics: ReadonlyArray<string>; data: string };

/**
 * Live canary for the DEPLOYED ArticleActions on Monad testnet — not a local
 * fork. Mirrors test/articleActions.test.ts but hits the real contract:
 *
 *   fund a throwaway wallet -> publish a fresh article (deployer = author =
 *   treasury) -> like / dislike / favorite / reply / tip -> assert balances,
 *   counts, flags and events -> then drive every revert path and confirm it
 *   fails atomically. Prints a PASS/FAIL table for ~9 scenarios.
 *
 *   npm run actions-smoke:monad -w @attention-press/contracts
 *
 * Env (optional): SMOKE_TIP_WMON (default "0.25").
 * The freshly published canary article is retired at the end.
 */

const wethAbi = [
  "function deposit() payable",
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Result = { label: string; ok: boolean; soft: boolean; detail: string };
const results: Result[] = [];
function record(label: string, ok: boolean, detail: string, soft = false) {
  results.push({ label, ok, soft, detail });
  const tag = ok ? (soft ? "PASS(⚠)" : "PASS") : "FAIL";
  console.log(`  [${tag}] ${label} — ${detail}`);
  return ok;
}

async function main() {
  if (network.name !== "monadTestnet") throw new Error("run with --network monadTestnet");

  const rec = JSON.parse(readFileSync(join(__dirname, "..", "deployments", "monadTestnet.json"), "utf8"));
  const registryAddr: string = rec.contracts.ArticleRegistry;
  const actionsAddr: string = rec.contracts.ArticleActions;
  const tokenAddr: string = rec.contracts.paymentToken;
  if (!actionsAddr) throw new Error("deployments/monadTestnet.json has no contracts.ArticleActions — run deploy-actions.ts");

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("no deployer signer (set DEPLOYER_KEY)");

  const feeBps = BigInt(rec.actionFeeBps ?? rec.protocolFeeBps ?? 250);
  const feeOf = (price: bigint) => (price * feeBps) / 10_000n;

  const registryD = await ethers.getContractAt("ArticleRegistry", registryAddr, deployer);
  const actionsD = await ethers.getContractAt("ArticleActions", actionsAddr, deployer);
  const iface = actionsD.interface;

  // Prices straight from the live contract.
  const LIKE: bigint = await actionsD.LIKE_PRICE();
  const DISLIKE: bigint = await actionsD.DISLIKE_PRICE();
  const FAVORITE: bigint = await actionsD.FAVORITE_PRICE();
  const REPLY: bigint = await actionsD.REPLY_PRICE();
  const MAX_REPLY_BYTES: bigint = await actionsD.MAX_REPLY_BYTES();
  const TIP = ethers.parseUnits(process.env.SMOKE_TIP_WMON ?? "0.25", 18);
  const onchainFeeBps: bigint = await actionsD.actionFeeBps();

  const treasury: string = await actionsD.treasury();
  const isAuthorTreasury = treasury.toLowerCase() === deployer.address.toLowerCase();

  console.log(`ArticleActions:   ${actionsAddr}`);
  console.log(`Payment token:    ${tokenAddr} (${rec.paymentTokenIsMock ? "MockERC20" : "WMON"})`);
  console.log(`Deployer/author:  ${deployer.address}`);
  console.log(`Treasury:         ${treasury}${isAuthorTreasury ? "  (== author, so author nets the full price on fee actions)" : ""}`);
  console.log(`Fee bps:          ${onchainFeeBps} (record says ${feeBps})`);
  console.log(`Prices:           like/dislike/fav ${ethers.formatUnits(LIKE, 18)} / reply ${ethers.formatUnits(REPLY, 18)} / tip ${ethers.formatUnits(TIP, 18)}`);
  if (rec.paymentTokenIsMock) throw new Error("this canary expects the WMON deployment (paymentTokenIsMock=true)");
  if (onchainFeeBps !== feeBps) console.log("  note: on-chain fee bps differs from the deployment record; using the on-chain value.");
  const effFeeBps = onchainFeeBps;
  const effFeeOf = (price: bigint) => (price * effFeeBps) / 10_000n;

  // --- wallets ----------------------------------------------------------------
  const w1 = ethers.Wallet.createRandom().connect(ethers.provider); // acts on the article
  const w2 = ethers.Wallet.createRandom().connect(ethers.provider); // clean wallet for the atomicity check
  console.log(`\nThrowaway actor w1: ${w1.address}`);
  console.log(`Throwaway actor w2: ${w2.address}`);

  const w1Fund = LIKE + DISLIKE + FAVORITE + REPLY + TIP + ethers.parseUnits("0.5", 18);
  const w2Fund = ethers.parseUnits("1", 18);
  const wrapTotal = w1Fund + w2Fund;
  const gas1 = ethers.parseEther("0.4");
  const gas2 = ethers.parseEther("0.3");
  const need = wrapTotal + gas1 + gas2 + ethers.parseEther("0.4");

  const depMon = await ethers.provider.getBalance(deployer.address);
  console.log(`\nDeployer MON balance: ${ethers.formatEther(depMon)} (need ~${ethers.formatEther(need)})`);
  if (depMon < need) {
    throw new Error(`deployer needs ~${ethers.formatEther(need)} MON — fund ${deployer.address} from the faucet and re-run`);
  }

  // --- fund gas -------------------------------------------------------------
  await (await deployer.sendTransaction({ to: w1.address, value: gas1 })).wait();
  await (await deployer.sendTransaction({ to: w2.address, value: gas2 })).wait();

  // --- wrap + distribute WMON (Monad applies state after the receipt) ------
  const tokenD = new ethers.Contract(tokenAddr, wethAbi, deployer);
  const tokenW1 = new ethers.Contract(tokenAddr, wethAbi, w1);
  const tokenW2 = new ethers.Contract(tokenAddr, wethAbi, w2);
  await (await tokenD.deposit({ value: wrapTotal })).wait();
  await waitForBalance(tokenD, deployer.address, wrapTotal, "deployer WMON");
  await (await tokenD.transfer(w1.address, w1Fund)).wait();
  await (await tokenD.transfer(w2.address, w2Fund)).wait();
  await waitForBalance(tokenW1, w1.address, w1Fund, "w1 WMON");
  await waitForBalance(tokenW2, w2.address, w2Fund, "w2 WMON");

  // --- publish the canary article (deployer is the author) ----------------
  const contentHash = ethers.keccak256(ethers.toUtf8Bytes(`actions-smoke ${Date.now()}`));
  const pubRc = await (await registryD.publish(contentHash, "ipfs://actions-smoke")).wait();
  const pubEv = pubRc!.logs
    .map((l: ParsableLog) => { try { return registryD.interface.parseLog(l); } catch { return null; } })
    .find((e: { name: string } | null) => e?.name === "Published");
  const articleId: bigint = pubEv!.args.id;
  console.log(`\nPublished canary article id ${articleId}\n`);

  const actionsW1 = actionsD.connect(w1);
  const actionsW2 = actionsD.connect(w2);

  const bal = (who: string) => tokenD.balanceOf(who) as Promise<bigint>;
  const eventFrom = (rc: ContractTransactionReceipt, name: string) =>
    rc.logs
      .map((l: ParsableLog) => { try { return iface.parseLog(l); } catch { return null; } })
      .find((e: { name: string } | null) => e?.name === name);

  // =======================================================================
  // 1. like
  // =======================================================================
  console.log("1. like");
  {
    const dep0 = await bal(deployer.address);
    const w0 = await bal(w1.address);
    const c0: bigint = await actionsD.likeCount(articleId);
    await (await tokenW1.approve(actionsAddr, LIKE)).wait();
    const rc = await (await actionsW1.like(articleId)).wait();
    const ev = eventFrom(rc!, "Liked");
    const evOk =
      !!ev &&
      ev.args.articleId === articleId &&
      ev.args.actor.toLowerCase() === w1.address.toLowerCase() &&
      ev.args.toAuthor === LIKE - effFeeOf(LIKE) &&
      ev.args.fee === effFeeOf(LIKE);
    const c1 = await pollUntil(() => actionsD.likeCount(articleId), (v) => v === c0 + 1n, "likeCount++");
    const flag: boolean = await actionsD.hasLiked(articleId, w1.address);
    const depD = (await bal(deployer.address)) - dep0;
    const wD = w0 - (await bal(w1.address));
    record(
      "like succeeds",
      evOk && c1 === c0 + 1n && flag === true && depD === LIKE && wD === LIKE,
      `Liked event ${evOk ? "ok" : "BAD"}, count ${c0}->${c1}, hasLiked=${flag}, author +${ethers.formatUnits(depD, 18)}, actor -${ethers.formatUnits(wD, 18)}`,
    );
  }

  // =======================================================================
  // 2. dislike (100% to treasury, no fee split)
  // =======================================================================
  console.log("2. dislike");
  {
    const dep0 = await bal(deployer.address);
    const w0 = await bal(w1.address);
    const c0: bigint = await actionsD.dislikeCount(articleId);
    await (await tokenW1.approve(actionsAddr, DISLIKE)).wait();
    const rc = await (await actionsW1.dislike(articleId)).wait();
    const ev = eventFrom(rc!, "Disliked");
    const evOk =
      !!ev &&
      ev.args.articleId === articleId &&
      ev.args.actor.toLowerCase() === w1.address.toLowerCase() &&
      ev.args.toTreasury === DISLIKE;
    const c1 = await pollUntil(() => actionsD.dislikeCount(articleId), (v) => v === c0 + 1n, "dislikeCount++");
    const flag: boolean = await actionsD.hasDisliked(articleId, w1.address);
    const depD = (await bal(deployer.address)) - dep0; // deployer == treasury
    const wD = w0 - (await bal(w1.address));
    record(
      "dislike succeeds (full price to treasury)",
      evOk && c1 === c0 + 1n && flag === true && depD === DISLIKE && wD === DISLIKE,
      `Disliked event ${evOk ? "ok" : "BAD"}, count ${c0}->${c1}, hasDisliked=${flag}, treasury +${ethers.formatUnits(depD, 18)}`,
    );
  }

  // =======================================================================
  // 3. favorite
  // =======================================================================
  console.log("3. favorite");
  {
    const dep0 = await bal(deployer.address);
    const w0 = await bal(w1.address);
    const c0: bigint = await actionsD.favoriteCount(articleId);
    await (await tokenW1.approve(actionsAddr, FAVORITE)).wait();
    const rc = await (await actionsW1.favorite(articleId)).wait();
    const ev = eventFrom(rc!, "Favorited");
    const evOk =
      !!ev &&
      ev.args.toAuthor === FAVORITE - effFeeOf(FAVORITE) &&
      ev.args.fee === effFeeOf(FAVORITE) &&
      ev.args.actor.toLowerCase() === w1.address.toLowerCase();
    const c1 = await pollUntil(() => actionsD.favoriteCount(articleId), (v) => v === c0 + 1n, "favoriteCount++");
    const flag: boolean = await actionsD.hasFavorited(articleId, w1.address);
    const depD = (await bal(deployer.address)) - dep0;
    const wD = w0 - (await bal(w1.address));
    record(
      "favorite succeeds",
      evOk && c1 === c0 + 1n && flag === true && depD === FAVORITE && wD === FAVORITE,
      `Favorited event ${evOk ? "ok" : "BAD"}, count ${c0}->${c1}, hasFavorited=${flag}, author +${ethers.formatUnits(depD, 18)}`,
    );
  }

  // =======================================================================
  // 4. reply (text in the event; {actor, blockTime} on-chain)
  // =======================================================================
  console.log("4. reply");
  {
    const dep0 = await bal(deployer.address);
    const w0 = await bal(w1.address);
    const c0: bigint = await actionsD.replyCount(articleId);
    const text = `canary reply @ ${new Date().toISOString()}`;
    await (await tokenW1.approve(actionsAddr, REPLY)).wait();
    const rc = await (await actionsW1.reply(articleId, text)).wait();
    const ev = eventFrom(rc!, "Replied");
    const evOk =
      !!ev &&
      ev.args.index === c0 &&
      ev.args.text === text &&
      ev.args.toAuthor === REPLY - effFeeOf(REPLY) &&
      ev.args.fee === effFeeOf(REPLY) &&
      ev.args.actor.toLowerCase() === w1.address.toLowerCase();
    const c1 = await pollUntil(() => actionsD.replyCount(articleId), (v) => v === c0 + 1n, "replyCount++");
    const [storedActor, storedTime] = await actionsD.replyAt(articleId, c0);
    const storedOk = storedActor.toLowerCase() === w1.address.toLowerCase() && storedTime > 0n;
    const depD = (await bal(deployer.address)) - dep0;
    const wD = w0 - (await bal(w1.address));
    record(
      "reply succeeds",
      evOk && c1 === c0 + 1n && storedOk && depD === REPLY && wD === REPLY,
      `Replied event ${evOk ? "ok" : "BAD"} (index ${ev?.args.index}), count ${c0}->${c1}, replyAt=${storedOk ? "ok" : "BAD"}, author +${ethers.formatUnits(depD, 18)}`,
    );
  }

  // =======================================================================
  // 5. tip (reader-chosen amount)
  // =======================================================================
  console.log("5. tip");
  {
    const dep0 = await bal(deployer.address);
    const w0 = await bal(w1.address);
    const t0: bigint = await actionsD.totalTipped(articleId);
    await (await tokenW1.approve(actionsAddr, TIP)).wait();
    const rc = await (await actionsW1.tip(articleId, TIP)).wait();
    const ev = eventFrom(rc!, "Tipped");
    const evOk =
      !!ev &&
      ev.args.toAuthor === TIP - effFeeOf(TIP) &&
      ev.args.fee === effFeeOf(TIP) &&
      ev.args.actor.toLowerCase() === w1.address.toLowerCase();
    const t1 = await pollUntil(() => actionsD.totalTipped(articleId), (v) => v === t0 + TIP, "totalTipped += amount");
    const depD = (await bal(deployer.address)) - dep0;
    const wD = w0 - (await bal(w1.address));
    record(
      "tip succeeds",
      evOk && t1 === t0 + TIP && depD === TIP && wD === TIP,
      `Tipped event ${evOk ? "ok" : "BAD"}, totalTipped ${ethers.formatUnits(t0, 18)}->${ethers.formatUnits(t1, 18)}, author +${ethers.formatUnits(depD, 18)}`,
    );
  }

  // =======================================================================
  // 6. duplicate like / dislike / favorite from the same wallet -> revert
  // =======================================================================
  console.log("6. duplicate one-shot actions revert");
  {
    const a = await expectRevert("dup like", () => actionsW1.like(articleId), iface, "AlreadyLiked");
    const b = await expectRevert("dup dislike", () => actionsW1.dislike(articleId), iface, "AlreadyDisliked");
    const c = await expectRevert("dup favorite", () => actionsW1.favorite(articleId), iface, "AlreadyFavorited");
    record("duplicate like/dislike/favorite all revert", a && b && c, "AlreadyLiked / AlreadyDisliked / AlreadyFavorited");
  }

  // =======================================================================
  // 7. self-action as the article's author -> SelfAction
  // =======================================================================
  console.log("7. self-action as author reverts");
  {
    const ok = await expectRevert("author likes own article", () => actionsD.like(articleId), iface, "SelfAction");
    record("author cannot act on own article", ok, "reverts SelfAction (blocks the address, not just role reuse)");
  }

  // =======================================================================
  // 8. transferFrom failure (allowance < price) is atomic — zero state change
  // =======================================================================
  console.log("8. underfunded action is atomic");
  {
    const likeCount0: bigint = await actionsD.likeCount(articleId);
    const flag0: boolean = await actionsD.hasLiked(articleId, w2.address);
    const w2Bal0 = await bal(w2.address);
    const depBal0 = await bal(deployer.address);

    await (await tokenW2.approve(actionsAddr, LIKE - 1n)).wait();
    const reverted = await expectRevert(
      "like with allowance = price - 1",
      () => actionsW2.like(articleId),
      iface,
      undefined, // OZ ERC20InsufficientAllowance, not one of our custom errors
    );

    await sleep(3000);
    const likeCount1: bigint = await actionsD.likeCount(articleId);
    const flag1: boolean = await actionsD.hasLiked(articleId, w2.address);
    const w2Bal1 = await bal(w2.address);
    const depBal1 = await bal(deployer.address);
    const noChange =
      likeCount1 === likeCount0 && flag1 === false && w2Bal1 === w2Bal0 && depBal1 === depBal0;
    record(
      "underfunded like reverts with zero state change",
      reverted && noChange,
      `reverted=${reverted}; likeCount ${likeCount0}->${likeCount1}, hasLiked=${flag1}, actor balance ${w2Bal1 === w2Bal0 ? "unchanged" : "MOVED"}, author balance ${depBal1 === depBal0 ? "unchanged" : "MOVED"}`,
    );
  }

  // =======================================================================
  // 9. reply longer than MAX_REPLY_BYTES -> BadParams
  // =======================================================================
  console.log("9. over-long reply reverts");
  {
    const c0: bigint = await actionsD.replyCount(articleId);
    const w0 = await bal(w1.address);
    const tooLong = "x".repeat(Number(MAX_REPLY_BYTES) + 1);
    await (await tokenW1.approve(actionsAddr, REPLY)).wait();
    const reverted = await expectRevert(
      `reply ${tooLong.length} bytes (max ${MAX_REPLY_BYTES})`,
      () => actionsW1.reply(articleId, tooLong),
      iface,
      "BadParams",
    );
    await sleep(3000);
    const c1: bigint = await actionsD.replyCount(articleId);
    const w1Bal = await bal(w1.address);
    record(
      "over-long reply reverts, no count/balance change",
      reverted && c1 === c0 && w1Bal === w0,
      `reverted=${reverted}; replyCount ${c0}->${c1}, actor balance ${w1Bal === w0 ? "unchanged" : "MOVED"}`,
    );
  }

  // --- tidy up: retire the canary article --------------------------------
  try {
    await (await registryD.retire(articleId)).wait();
    console.log(`\nRetired canary article ${articleId}.`);
  } catch (e) {
    console.log(`\n(could not retire canary article ${articleId}: ${e instanceof Error ? e.message : e})`);
  }

  // --- summary ----------------------------------------------------------
  console.log(`\n${"=".repeat(64)}\nLIVE CANARY SUMMARY — ArticleActions @ ${actionsAddr}\n${"=".repeat(64)}`);
  for (const r of results) {
    console.log(`${r.ok ? (r.soft ? "⚠ PASS" : "✓ PASS") : "✗ FAIL"}  ${r.label}`);
  }
  const failed = results.filter((r) => !r.ok);
  const soft = results.filter((r) => r.ok && r.soft);
  console.log("=".repeat(64));
  console.log(`${results.length} scenarios · ${results.length - failed.length} passed · ${failed.length} failed${soft.length ? ` · ${soft.length} soft (reverted but RPC hid the error name)` : ""}`);
  if (failed.length) {
    process.exitCode = 1;
    console.log("\nFAILURES:");
    for (const r of failed) console.log(`  - ${r.label}: ${r.detail}`);
  } else {
    console.log("\n✅ live deployment behaves correctly on all scenarios");
  }
}

// ---------------------------------------------------------------------------

async function expectRevert(
  label: string,
  fn: () => Promise<unknown>,
  iface: EthersInterface,
  wantErr: string | undefined,
): Promise<boolean> {
  try {
    const tx = (await fn()) as { wait?: () => Promise<unknown> };
    if (tx && typeof tx.wait === "function") await tx.wait();
  } catch (e) {
    const name = decodeErrName(e, iface);
    if (wantErr === undefined) return record(`  ${label}`, true, name ? `reverted (${name})` : "reverted");
    if (name === wantErr) return record(`  ${label}`, true, `reverted ${name}`);
    if (name === null)
      return record(`  ${label}`, true, `reverted, but RPC did not surface the error name (wanted ${wantErr})`, true);
    return record(`  ${label}`, false, `reverted with ${name}, wanted ${wantErr}`);
  }
  return record(`  ${label}`, false, "did NOT revert");
}

function decodeErrName(e: unknown, iface: EthersInterface): string | null {
  const err = e as {
    revert?: { name?: string };
    data?: unknown;
    info?: { error?: { data?: unknown } };
    error?: { data?: unknown; error?: { data?: unknown } };
    shortMessage?: string;
  };
  if (err?.revert?.name) return err.revert.name;
  const candidates = [err?.data, err?.info?.error?.data, err?.error?.data, err?.error?.error?.data];
  for (const d of candidates) {
    if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) {
      try {
        const parsed = iface.parseError(d);
        if (parsed) return parsed.name;
      } catch {
        /* not a known custom error */
      }
    }
  }
  // last resort: some nodes put "...custom error 'BadParams()'" in the message
  const m = err?.shortMessage?.match(/custom error '([A-Za-z0-9_]+)\(/);
  return m ? m[1] : null;
}

async function waitForBalance(
  token: EthersContract,
  who: string,
  target: bigint,
  label: string,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await token.balanceOf(who)) >= target) return;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${label} >= ${target}`);
}

async function pollUntil<T>(
  read: () => Promise<T>,
  pred: (v: T) => boolean,
  label: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (pred(last)) return last;
    await sleep(2000);
  }
  throw new Error(`timed out: ${label} (last=${String(last)})`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
