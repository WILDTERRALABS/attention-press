import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HDNodeWallet, Wallet } from "ethers";

const CONTENT_HASH = ethers.keccak256(ethers.toUtf8Bytes("the canonical article body"));
const BUDGET = ethers.parseEther("1");
const RATE = 1_000_000_000_000n; // wei per second → "budget seconds" = 1e6
const FEE_BPS = 250n; // 2.5%
const CHALLENGE_WINDOW = 15n * 60n; // contract default, seconds
const PAST_WINDOW = Number(CHALLENGE_WINDOW) + 1;

async function deploy() {
  const [owner, author, reader, treasury, other] = await ethers.getSigners();

  const registry = await (await ethers.getContractFactory("ArticleRegistry")).deploy();
  const token = await (await ethers.getContractFactory("MockERC20")).deploy();
  const stream = await (await ethers.getContractFactory("AttentionStream")).deploy(
    await token.getAddress(),
    await registry.getAddress(),
    treasury.address,
    FEE_BPS,
  );

  await token.mint(reader.address, ethers.parseEther("1000"));
  await token.mint(author.address, ethers.parseEther("1000"));
  await token.connect(reader).approve(await stream.getAddress(), ethers.MaxUint256);
  await token.connect(author).approve(await stream.getAddress(), ethers.MaxUint256);

  await registry.connect(author).publish(CONTENT_HASH, "ipfs://meta");
  const articleId = 1n;

  return { owner, author, reader, treasury, other, registry, token, stream, articleId };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function openSession(stream: any, reader: any, articleId: bigint, signer: HDNodeWallet | Wallet) {
  const tx = await stream.connect(reader).openSession(articleId, BUDGET, RATE, signer.address);
  const rc = await tx.wait();
  const ev = rc!.logs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((l: any) => {
      try {
        return stream.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .find((e: any) => e?.name === "SessionOpened");
  return ev!.args.id as string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function signVoucher(stream: any, signer: HDNodeWallet | Wallet, sessionId: string, cumulativeAmount: bigint) {
  const domain = {
    name: "AttentionStream",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await stream.getAddress(),
  };
  const types = {
    Voucher: [
      { name: "sessionId", type: "bytes32" },
      { name: "cumulativeAmount", type: "uint256" },
    ],
  };
  return signer.signTypedData(domain, types, { sessionId, cumulativeAmount });
}

describe("ArticleRegistry", () => {
  it("publishes with incrementing ids and records the author", async () => {
    const { registry, author, other } = await deploy();
    await registry.connect(other).publish(CONTENT_HASH, "ipfs://b");
    expect(await registry.authorOf(1n)).to.equal(author.address);
    expect(await registry.authorOf(2n)).to.equal(other.address);
    expect(await registry.nextId()).to.equal(3n);
  });

  it("rejects an empty content hash", async () => {
    const { registry, author } = await deploy();
    await expect(registry.connect(author).publish(ethers.ZeroHash, "x")).to.be.revertedWithCustomError(
      registry,
      "EmptyContentHash",
    );
  });

  it("only the author can retire or update metadata", async () => {
    const { registry, author, other } = await deploy();
    await expect(registry.connect(other).retire(1n)).to.be.revertedWithCustomError(registry, "NotAuthor");
    await registry.connect(author).retire(1n);
    expect(await registry.isActive(1n)).to.equal(false);
  });
});

describe("AttentionStream", () => {
  it("openSession escrows the budget and rejects bad params", async () => {
    const { stream, reader, token, articleId } = await deploy();
    const key = ethers.Wallet.createRandom();
    const before = await token.balanceOf(await stream.getAddress());
    await openSession(stream, reader, articleId, key);
    expect((await token.balanceOf(await stream.getAddress())) - before).to.equal(BUDGET);

    await expect(stream.connect(reader).openSession(articleId, 0, RATE, key.address)).to.be.revertedWithCustomError(
      stream,
      "BadParams",
    );
    await expect(
      stream.connect(reader).openSession(articleId, BUDGET, RATE, ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(stream, "BadParams");
  });

  it("rejects sessions against a retired article", async () => {
    const { stream, reader, registry, author, articleId } = await deploy();
    await registry.connect(author).retire(articleId);
    const key = ethers.Wallet.createRandom();
    await expect(
      stream.connect(reader).openSession(articleId, BUDGET, RATE, key.address),
    ).to.be.revertedWithCustomError(stream, "ArticleInactive");
  });

  it("settles a valid voucher, paying author minus fee and treasury the fee", async () => {
    const { stream, reader, author, treasury, token, articleId } = await deploy();
    const key = ethers.Wallet.createRandom();
    const id = await openSession(stream, reader, articleId, key);

    await time.increase(120);
    const cumulative = RATE * 100n; // safely under rate cap and budget
    const sig = await signVoucher(stream, key, id, cumulative);

    const authorBefore = await token.balanceOf(author.address);
    const treasuryBefore = await token.balanceOf(treasury.address);

    await stream.settle(id, cumulative, sig);

    const fee = (cumulative * FEE_BPS) / 10_000n;
    expect((await token.balanceOf(author.address)) - authorBefore).to.equal(cumulative - fee);
    expect((await token.balanceOf(treasury.address)) - treasuryBefore).to.equal(fee);
    expect(await stream.articleEarned(articleId)).to.equal(cumulative);
  });

  it("rejects non-monotonic, over-budget, over-rate and mis-signed vouchers", async () => {
    const { stream, reader, articleId } = await deploy();
    const key = ethers.Wallet.createRandom();
    const wrongKey = ethers.Wallet.createRandom();
    const id = await openSession(stream, reader, articleId, key);
    await time.increase(120);

    const base = RATE * 50n;
    await stream.settle(id, base, await signVoucher(stream, key, id, base));

    await expect(
      stream.settle(id, base - 1n, await signVoucher(stream, key, id, base - 1n)),
    ).to.be.revertedWithCustomError(stream, "NonMonotonic");

    const over = BUDGET + 1n;
    await expect(stream.settle(id, over, await signVoucher(stream, key, id, over))).to.be.revertedWithCustomError(
      stream,
      "OverBudget",
    );

    const overRate = RATE * 500_000n; // < budget, >> rate*elapsed
    await expect(
      stream.settle(id, overRate, await signVoucher(stream, key, id, overRate)),
    ).to.be.revertedWithCustomError(stream, "RateExceeded");

    const amt = RATE * 60n;
    await expect(
      stream.settle(id, amt, await signVoucher(stream, wrongKey, id, amt)),
    ).to.be.revertedWithCustomError(stream, "BadSignature");
  });

  // -------------------------------------------------------------------------
  // Two-phase closure
  // -------------------------------------------------------------------------

  it("close -> challenge window -> finalize refunds budget - claimed", async () => {
    const { stream, reader, token, articleId } = await deploy();
    const key = ethers.Wallet.createRandom();
    const id = await openSession(stream, reader, articleId, key);
    await time.increase(120);

    const cumulative = RATE * 90n;
    await stream.settle(id, cumulative, await signVoucher(stream, key, id, cumulative));

    await stream.connect(reader).closeSession(id);
    expect(await stream.closeInitiatedAt(id)).to.be.greaterThan(0n);
    expect((await stream.sessions(id)).open).to.equal(true); // still open during the window

    await expect(stream.finalizeSession(id)).to.be.revertedWithCustomError(stream, "ChallengeWindowOpen");

    await time.increase(PAST_WINDOW);
    const readerBefore = await token.balanceOf(reader.address);
    await stream.finalizeSession(id);

    expect((await token.balanceOf(reader.address)) - readerBefore).to.equal(BUDGET - cumulative);
    expect((await stream.sessions(id)).open).to.equal(false);

    await expect(stream.connect(reader).closeSession(id)).to.be.revertedWithCustomError(stream, "SessionNotOpen");
    await expect(stream.finalizeSession(id)).to.be.revertedWithCustomError(stream, "SessionNotOpen");
  });

  it("collector settles a fresh voucher DURING the window after the reader front-runs closeSession (3.6)", async () => {
    const { stream, reader, author, token, articleId } = await deploy();
    const key = ethers.Wallet.createRandom();
    const id = await openSession(stream, reader, articleId, key);
    await time.increase(300);

    // reader signs a fresh voucher but does NOT settle it, then races a close
    const fresh = RATE * 250n;
    const sig = await signVoucher(stream, key, id, fresh);
    await stream.connect(reader).closeSession(id);

    // collector still gets it in, inside the window, capped at the close time
    const authorBefore = await token.balanceOf(author.address);
    await stream.settle(id, fresh, sig);
    const fee = (fresh * FEE_BPS) / 10_000n;
    expect((await token.balanceOf(author.address)) - authorBefore).to.equal(fresh - fee);
    expect((await stream.sessions(id)).claimed).to.equal(fresh);

    await time.increase(PAST_WINDOW);
    const readerBefore = await token.balanceOf(reader.address);
    await stream.finalizeSession(id);
    expect((await token.balanceOf(reader.address)) - readerBefore).to.equal(BUDGET - fresh);
  });

  it("settle after the challenge window is rejected", async () => {
    const { stream, reader, articleId } = await deploy();
    const key = ethers.Wallet.createRandom();
    const id = await openSession(stream, reader, articleId, key);
    await time.increase(120);
    await stream.connect(reader).closeSession(id);
    await time.increase(PAST_WINDOW);

    const amt = RATE * 100n;
    await expect(
      stream.settle(id, amt, await signVoucher(stream, key, id, amt)),
    ).to.be.revertedWithCustomError(stream, "ChallengeWindowClosed");
  });

  it("a voucher above the frozen close-time cap is rejected even when under budget and the live rate cap (3.5)", async () => {
    const { stream, reader, articleId } = await deploy();
    const key = ethers.Wallet.createRandom();
    const id = await openSession(stream, reader, articleId, key);

    await time.increase(100); // ~100s elapsed
    await stream.connect(reader).closeSession(id); // accrual frozen at ~101s of rate

    await time.increase(500); // live rate cap would now allow ~601s of rate
    const amt = RATE * 300n; // < budget (1e6 s), < live cap (601 s), > frozen cap (~101 s)
    await expect(
      stream.settle(id, amt, await signVoucher(stream, key, id, amt)),
    ).to.be.revertedWithCustomError(stream, "RateExceeded");
  });

  it("double closeSession reverts AlreadyClosing; finalize before close reverts NotClosing", async () => {
    const { stream, reader, articleId } = await deploy();
    const key = ethers.Wallet.createRandom();
    const id = await openSession(stream, reader, articleId, key);

    await expect(stream.finalizeSession(id)).to.be.revertedWithCustomError(stream, "NotClosing");
    await stream.connect(reader).closeSession(id);
    await expect(stream.connect(reader).closeSession(id)).to.be.revertedWithCustomError(stream, "AlreadyClosing");
  });

  it("non-reader cannot close before MAX_ACCRUAL_WINDOW; anyone can after (abandoned recovery)", async () => {
    const { stream, reader, other, token, articleId } = await deploy();
    const key = ethers.Wallet.createRandom();
    const id = await openSession(stream, reader, articleId, key);

    await expect(stream.connect(other).closeSession(id)).to.be.revertedWithCustomError(stream, "NotReader");

    await time.increase(7 * 24 * 60 * 60); // MAX_ACCRUAL_WINDOW
    await stream.connect(other).closeSession(id); // now permissionless
    await time.increase(PAST_WINDOW);

    const readerBefore = await token.balanceOf(reader.address);
    await stream.connect(other).finalizeSession(id); // permissionless; refund still to the reader
    expect((await token.balanceOf(reader.address)) - readerBefore).to.equal(BUDGET);
  });

  it("collector-less reader recovers the full budget with no voucher", async () => {
    const { stream, reader, token, articleId } = await deploy();
    const key = ethers.Wallet.createRandom();
    const id = await openSession(stream, reader, articleId, key);
    await time.increase(200);

    await stream.connect(reader).closeSession(id);
    await time.increase(PAST_WINDOW);
    const before = await token.balanceOf(reader.address);
    await stream.connect(reader).finalizeSession(id);
    expect((await token.balanceOf(reader.address)) - before).to.equal(BUDGET);
  });

  it("self-funded reading is strictly loss-making (fee is burned)", async () => {
    const { stream, registry, token, treasury, author } = await deploy();
    await token.connect(author).approve(await stream.getAddress(), ethers.MaxUint256);
    await registry.connect(author).publish(CONTENT_HASH, "ipfs://self");
    const selfArticle = 2n;

    const key = ethers.Wallet.createRandom();
    const authorStart = await token.balanceOf(author.address);
    const treasuryStart = await token.balanceOf(treasury.address);

    const id = await openSession(stream, author, selfArticle, key);
    await time.increase(120);
    const cumulative = RATE * 100n;
    await stream.settle(id, cumulative, await signVoucher(stream, key, id, cumulative));
    await stream.connect(author).closeSession(id);
    await time.increase(PAST_WINDOW);
    await stream.finalizeSession(id);

    const fee = (cumulative * FEE_BPS) / 10_000n;
    expect((await token.balanceOf(author.address)) - authorStart).to.equal(-fee);
    expect((await token.balanceOf(treasury.address)) - treasuryStart).to.equal(fee);
  });

  it("admin setters are owner-gated and bounded", async () => {
    const { stream, owner, other } = await deploy();
    await expect(stream.connect(other).setProtocolFeeBps(100)).to.be.revertedWithCustomError(
      stream,
      "OwnableUnauthorizedAccount",
    );
    await expect(stream.connect(owner).setProtocolFeeBps(1001)).to.be.revertedWithCustomError(stream, "BadParams");
    await stream.connect(owner).setProtocolFeeBps(500);
    expect(await stream.protocolFeeBps()).to.equal(500n);

    await expect(stream.connect(owner).setChallengeWindow(59)).to.be.revertedWithCustomError(stream, "BadParams");
    await expect(stream.connect(owner).setChallengeWindow(24 * 60 * 60 + 1)).to.be.revertedWithCustomError(
      stream,
      "BadParams",
    );
    await expect(stream.connect(other).setChallengeWindow(1800)).to.be.revertedWithCustomError(
      stream,
      "OwnableUnauthorizedAccount",
    );
    await stream.connect(owner).setChallengeWindow(1800);
    expect(await stream.challengeWindow()).to.equal(1800n);
  });
});
