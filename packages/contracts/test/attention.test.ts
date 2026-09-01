import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HDNodeWallet, Wallet } from "ethers";

const CONTENT_HASH = ethers.keccak256(ethers.toUtf8Bytes("the canonical article body"));
const BUDGET = ethers.parseEther("1");
const RATE = 1_000_000_000_000n; // wei per second
const FEE_BPS = 250n; // 2.5%

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

async function openSession(stream: any, reader: any, articleId: bigint, signer: HDNodeWallet | Wallet) {
  const tx = await stream.connect(reader).openSession(articleId, BUDGET, RATE, signer.address);
  const rc = await tx.wait();
  const ev = rc!.logs
    .map((l: any) => {
      try {
        return stream.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e: any) => e?.name === "SessionOpened");
  return ev!.args.id as string;
}

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

    // settle a baseline first
    const base = RATE * 50n;
    await stream.settle(id, base, await signVoucher(stream, key, id, base));

    // non-monotonic
    await expect(
      stream.settle(id, base - 1n, await signVoucher(stream, key, id, base - 1n)),
    ).to.be.revertedWithCustomError(stream, "NonMonotonic");

    // over budget
    const over = BUDGET + 1n;
    await expect(stream.settle(id, over, await signVoucher(stream, key, id, over))).to.be.revertedWithCustomError(
      stream,
      "OverBudget",
    );

    // over rate cap (huge but still < budget)
    const overRate = RATE * 500_000n; // 5e17 < 1e18 budget, >> rate*elapsed
    await expect(
      stream.settle(id, overRate, await signVoucher(stream, key, id, overRate)),
    ).to.be.revertedWithCustomError(stream, "RateExceeded");

    // wrong signer
    const amt = RATE * 60n;
    await expect(
      stream.settle(id, amt, await signVoucher(stream, wrongKey, id, amt)),
    ).to.be.revertedWithCustomError(stream, "BadSignature");
  });

  it("lets the reader close and refunds the unspent budget", async () => {
    const { stream, reader, author, token, articleId } = await deploy();
    const key = ethers.Wallet.createRandom();
    const id = await openSession(stream, reader, articleId, key);
    await time.increase(120);

    const cumulative = RATE * 90n;
    const sig = await signVoucher(stream, key, id, cumulative);

    const readerBefore = await token.balanceOf(reader.address);
    await stream.connect(reader).closeSession(id, cumulative, sig);

    expect((await token.balanceOf(reader.address)) - readerBefore).to.equal(BUDGET - cumulative);
    expect((await stream.sessions(id)).open).to.equal(false);

    // closing again fails
    await expect(stream.connect(reader).closeSession(id, cumulative, sig)).to.be.revertedWithCustomError(
      stream,
      "SessionNotOpen",
    );
  });

  it("non-reader cannot close", async () => {
    const { stream, reader, other, articleId } = await deploy();
    const key = ethers.Wallet.createRandom();
    const id = await openSession(stream, reader, articleId, key);
    await expect(
      stream.connect(other).closeSession(id, 0, "0x"),
    ).to.be.revertedWithCustomError(stream, "NotReader");
  });

  it("readerReclaim is blocked until the timeout, then returns the remainder", async () => {
    const { stream, reader, token, articleId } = await deploy();
    const key = ethers.Wallet.createRandom();
    const id = await openSession(stream, reader, articleId, key);

    await expect(stream.connect(reader).readerReclaim(id)).to.be.revertedWithCustomError(stream, "TooEarly");

    await time.increase(3 * 24 * 60 * 60 + 1);
    const before = await token.balanceOf(reader.address);
    await stream.connect(reader).readerReclaim(id);
    expect((await token.balanceOf(reader.address)) - before).to.equal(BUDGET);
  });

  it("self-funded reading is strictly loss-making (fee is burned)", async () => {
    // reader == author: value cycles back, minus the protocol fee.
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
    await stream.connect(author).closeSession(id, cumulative, "0x");

    const fee = (cumulative * FEE_BPS) / 10_000n;
    // net change for the author-controlled cluster == -fee
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

    await expect(stream.connect(owner).setSessionTimeout(60)).to.be.revertedWithCustomError(stream, "BadParams");
    await stream.connect(owner).setSessionTimeout(7 * 24 * 60 * 60);
    expect(await stream.sessionTimeout()).to.equal(BigInt(7 * 24 * 60 * 60));
  });
});
