import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const HASH = ethers.keccak256(ethers.toUtf8Bytes("body"));
const ONE = ethers.parseEther("1");
const TWO = ethers.parseEther("2");
const FEE_BPS = 250n; // 2.5%
const feeOf = (price: bigint) => (price * FEE_BPS) / 10_000n;

async function deploy(feeBps = FEE_BPS) {
  const [owner, author, reader, reader2, treasury] = await ethers.getSigners();

  const registry = await (await ethers.getContractFactory("ArticleRegistry")).deploy();
  const token = await (await ethers.getContractFactory("MockERC20")).deploy();
  const actions = await (await ethers.getContractFactory("ArticleActions")).deploy(
    await token.getAddress(),
    await registry.getAddress(),
    treasury.address,
    feeBps,
  );
  const actionsAddr = await actions.getAddress();

  for (const w of [reader, reader2]) {
    await token.mint(w.address, ethers.parseEther("1000"));
    await token.connect(w).approve(actionsAddr, ethers.MaxUint256);
  }
  await token.mint(author.address, ethers.parseEther("1000"));
  await token.connect(author).approve(actionsAddr, ethers.MaxUint256);

  await registry.connect(author).publish(HASH, "ipfs://meta");
  const articleId = 1n;

  return { owner, author, reader, reader2, treasury, registry, token, actions, actionsAddr, articleId };
}

describe("ArticleActions", () => {
  describe("like / favorite", () => {
    it("pays the author price-minus-fee, fee to treasury, sets the flag and count", async () => {
      const { author, reader, treasury, token, actions, articleId } = await deploy();
      const a0 = await token.balanceOf(author.address);
      const t0 = await token.balanceOf(treasury.address);
      const r0 = await token.balanceOf(reader.address);

      await expect(actions.connect(reader).like(articleId))
        .to.emit(actions, "Liked")
        .withArgs(articleId, reader.address, ONE - feeOf(ONE), feeOf(ONE));

      expect(await token.balanceOf(author.address)).to.equal(a0 + ONE - feeOf(ONE));
      expect(await token.balanceOf(treasury.address)).to.equal(t0 + feeOf(ONE));
      expect(await token.balanceOf(reader.address)).to.equal(r0 - ONE);
      expect(await actions.hasLiked(articleId, reader.address)).to.equal(true);
      expect(await actions.likeCount(articleId)).to.equal(1n);
    });

    it("favorite behaves the same on its own flag/count", async () => {
      const { reader, actions, articleId } = await deploy();
      await actions.connect(reader).favorite(articleId);
      expect(await actions.hasFavorited(articleId, reader.address)).to.equal(true);
      expect(await actions.favoriteCount(articleId)).to.equal(1n);
      // like and favorite are independent
      await actions.connect(reader).like(articleId);
      expect(await actions.likeCount(articleId)).to.equal(1n);
    });

    it("reverts AlreadyLiked / AlreadyFavorited on repeat", async () => {
      const { reader, actions, articleId } = await deploy();
      await actions.connect(reader).like(articleId);
      await expect(actions.connect(reader).like(articleId)).to.be.revertedWithCustomError(actions, "AlreadyLiked");
      await actions.connect(reader).favorite(articleId);
      await expect(actions.connect(reader).favorite(articleId)).to.be.revertedWithCustomError(
        actions,
        "AlreadyFavorited",
      );
    });

    it("counts distinct likers", async () => {
      const { reader, reader2, actions, articleId } = await deploy();
      await actions.connect(reader).like(articleId);
      await actions.connect(reader2).like(articleId);
      expect(await actions.likeCount(articleId)).to.equal(2n);
    });
  });

  describe("dislike", () => {
    it("pays the full price to the treasury (never the author), no fee split", async () => {
      const { author, reader, treasury, token, actions, articleId } = await deploy();
      const a0 = await token.balanceOf(author.address);
      const t0 = await token.balanceOf(treasury.address);

      await expect(actions.connect(reader).dislike(articleId))
        .to.emit(actions, "Disliked")
        .withArgs(articleId, reader.address, ONE);

      expect(await token.balanceOf(author.address)).to.equal(a0); // author gets nothing
      expect(await token.balanceOf(treasury.address)).to.equal(t0 + ONE);
      expect(await actions.dislikeCount(articleId)).to.equal(1n);
    });

    it("reverts AlreadyDisliked on repeat", async () => {
      const { reader, actions, articleId } = await deploy();
      await actions.connect(reader).dislike(articleId);
      await expect(actions.connect(reader).dislike(articleId)).to.be.revertedWithCustomError(actions, "AlreadyDisliked");
    });
  });

  describe("reply", () => {
    it("pays the author, bumps the count, and emits the text", async () => {
      const { author, reader, token, actions, articleId } = await deploy();
      const a0 = await token.balanceOf(author.address);
      await expect(actions.connect(reader).reply(articleId, "nice piece"))
        .to.emit(actions, "Replied")
        .withArgs(articleId, reader.address, 0n, TWO - feeOf(TWO), feeOf(TWO), "nice piece");
      expect(await token.balanceOf(author.address)).to.equal(a0 + TWO - feeOf(TWO));
      expect(await actions.replyCount(articleId)).to.equal(1n);
      const r = await actions.replyAt(articleId, 0n);
      expect(r.actor).to.equal(reader.address);
      expect(r.blockTime).to.be.greaterThan(0n);
    });

    it("is repeatable and indexes sequentially", async () => {
      const { reader, reader2, actions, articleId } = await deploy();
      await actions.connect(reader).reply(articleId, "one");
      await actions.connect(reader).reply(articleId, "two");
      await actions.connect(reader2).reply(articleId, "three");
      expect(await actions.replyCount(articleId)).to.equal(3n);
      expect((await actions.replyAt(articleId, 2n)).actor).to.equal(reader2.address);
    });

    it("rejects empty and over-long text", async () => {
      const { reader, actions, articleId } = await deploy();
      await expect(actions.connect(reader).reply(articleId, "")).to.be.revertedWithCustomError(actions, "BadParams");
      await expect(
        actions.connect(reader).reply(articleId, "x".repeat(1001)),
      ).to.be.revertedWithCustomError(actions, "BadParams");
      await actions.connect(reader).reply(articleId, "x".repeat(1000)); // boundary ok
    });

    it("replyAt reverts for an unknown index", async () => {
      const { actions, articleId } = await deploy();
      await expect(actions.replyAt(articleId, 0n)).to.be.revertedWithCustomError(actions, "UnknownReply");
    });

    it("enforces MAX_REPLIES_PER_ARTICLE", async () => {
      const { reader, actions, actionsAddr, articleId } = await deploy();
      expect(await actions.MAX_REPLIES_PER_ARTICLE()).to.equal(100_000n);

      // Post one real reply so replyCount[articleId] == 1, then locate the
      // mapping's storage slot empirically (no hardcoded layout assumption):
      // it's the only base slot i in 0..31 for which keccak256(articleId, i)
      // holds 1 while like/dislike/favorite counts are still 0.
      await actions.connect(reader).reply(articleId, "first");
      expect(await actions.replyCount(articleId)).to.equal(1n);

      let replySlot: string | undefined;
      for (let i = 0n; i < 32n; i++) {
        const candidate = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [articleId, i]),
        );
        const raw = await ethers.provider.send("eth_getStorageAt", [actionsAddr, candidate, "latest"]);
        if (BigInt(raw) === 1n) {
          replySlot = candidate;
          break;
        }
      }
      expect(replySlot, "could not locate replyCount storage slot").to.not.equal(undefined);

      const near = 100_000n - 1n;
      await ethers.provider.send("hardhat_setStorageAt", [actionsAddr, replySlot!, ethers.toBeHex(near, 32)]);
      expect(await actions.replyCount(articleId)).to.equal(near); // confirms we hit the right slot

      await actions.connect(reader).reply(articleId, "the last allowed one"); // index 99_999 -> ok
      expect(await actions.replyCount(articleId)).to.equal(100_000n);
      await expect(actions.connect(reader).reply(articleId, "over the limit")).to.be.revertedWithCustomError(
        actions,
        "ReplyLimitReached",
      );
    });
  });

  describe("tip", () => {
    it("sends a reader-chosen amount to the author minus fee", async () => {
      const { author, reader, treasury, token, actions, articleId } = await deploy();
      const amount = ethers.parseEther("7");
      const a0 = await token.balanceOf(author.address);
      const t0 = await token.balanceOf(treasury.address);
      await expect(actions.connect(reader).tip(articleId, amount))
        .to.emit(actions, "Tipped")
        .withArgs(articleId, reader.address, amount - feeOf(amount), feeOf(amount));
      expect(await token.balanceOf(author.address)).to.equal(a0 + amount - feeOf(amount));
      expect(await token.balanceOf(treasury.address)).to.equal(t0 + feeOf(amount));
      expect(await actions.totalTipped(articleId)).to.equal(amount);
    });

    it("rejects a zero tip; accumulates across tips", async () => {
      const { reader, reader2, actions, articleId } = await deploy();
      await expect(actions.connect(reader).tip(articleId, 0n)).to.be.revertedWithCustomError(actions, "BadParams");
      await actions.connect(reader).tip(articleId, ethers.parseEther("1"));
      await actions.connect(reader2).tip(articleId, ethers.parseEther("2"));
      expect(await actions.totalTipped(articleId)).to.equal(ethers.parseEther("3"));
    });

    it("dust tip below the fee rounding still pays the author in full", async () => {
      const { author, reader, token, actions, articleId } = await deploy();
      const a0 = await token.balanceOf(author.address);
      await actions.connect(reader).tip(articleId, 3n); // 3 * 250 / 10000 == 0
      expect(await token.balanceOf(author.address)).to.equal(a0 + 3n);
    });
  });

  describe("guards", () => {
    it("blocks the author from acting on their own article", async () => {
      const { author, actions, articleId } = await deploy();
      for (const fn of [
        () => actions.connect(author).like(articleId),
        () => actions.connect(author).dislike(articleId),
        () => actions.connect(author).favorite(articleId),
        () => actions.connect(author).reply(articleId, "self"),
        () => actions.connect(author).tip(articleId, 1n),
      ]) {
        await expect(fn()).to.be.revertedWithCustomError(actions, "SelfAction");
      }
    });

    it("reverts every action on an inactive / retired article", async () => {
      const { author, reader, registry, actions, articleId } = await deploy();
      await registry.connect(author).retire(articleId);
      await expect(actions.connect(reader).like(articleId)).to.be.revertedWithCustomError(actions, "ArticleInactive");
      await expect(actions.connect(reader).tip(articleId, 1n)).to.be.revertedWithCustomError(actions, "ArticleInactive");
      await expect(actions.connect(reader).reply(articleId, "x")).to.be.revertedWithCustomError(actions, "ArticleInactive");
      // unknown id too
      await expect(actions.connect(reader).like(999n)).to.be.revertedWithCustomError(actions, "ArticleInactive");
    });

    it("is atomic when transferFrom fails (no allowance) — no flag, no count", async () => {
      const { reader2, token, actions, actionsAddr, articleId } = await deploy();
      await token.connect(reader2).approve(actionsAddr, ethers.parseEther("0.5")); // < LIKE_PRICE
      await expect(actions.connect(reader2).like(articleId)).to.be.reverted;
      expect(await actions.hasLiked(articleId, reader2.address)).to.equal(false);
      expect(await actions.likeCount(articleId)).to.equal(0n);
    });

    it("rejects an article whose author is this contract — no funds locked (3.2 / 3.4)", async () => {
      const { author, reader, registry, token, actions, actionsAddr, articleId } = await deploy();
      // attacker moves authorship to the ArticleActions contract itself
      await registry.connect(author).transferAuthorship(articleId, actionsAddr);

      for (const fn of [
        () => actions.connect(reader).like(articleId),
        () => actions.connect(reader).dislike(articleId),
        () => actions.connect(reader).favorite(articleId),
        () => actions.connect(reader).reply(articleId, "locked?"),
        () => actions.connect(reader).tip(articleId, ONE),
      ]) {
        await expect(fn()).to.be.revertedWithCustomError(actions, "InvalidRecipient");
      }

      // nothing recorded, nothing moved
      expect(await actions.likeCount(articleId)).to.equal(0n);
      expect(await actions.favoriteCount(articleId)).to.equal(0n);
      expect(await actions.replyCount(articleId)).to.equal(0n);
      expect(await actions.hasLiked(articleId, reader.address)).to.equal(false);
      expect(await token.balanceOf(actionsAddr)).to.equal(0n);
    });
  });

  describe("admin", () => {
    it("setActionFeeBps is owner-only and capped at 1000", async () => {
      const { owner, reader, actions } = await deploy();
      await expect(actions.connect(reader).setActionFeeBps(100)).to.be.revertedWithCustomError(
        actions,
        "OwnableUnauthorizedAccount",
      );
      await expect(actions.connect(owner).setActionFeeBps(1001)).to.be.revertedWithCustomError(actions, "BadParams");
      await actions.connect(owner).setActionFeeBps(0);
      expect(await actions.actionFeeBps()).to.equal(0n);
    });

    it("fee 0 sends the whole price to the author", async () => {
      const { author, reader, token, actions, articleId } = await deploy(0n);
      const a0 = await token.balanceOf(author.address);
      await actions.connect(reader).like(articleId);
      expect(await token.balanceOf(author.address)).to.equal(a0 + ONE);
    });

    it("treasury is immutable — no setter exists", async () => {
      const { actions } = await deploy();
      expect((actions as unknown as { setTreasury?: unknown }).setTreasury).to.equal(undefined);
    });

    it("constructor rejects a zero treasury / token / registry / over-cap fee", async () => {
      const registry = await (await ethers.getContractFactory("ArticleRegistry")).deploy();
      const token = await (await ethers.getContractFactory("MockERC20")).deploy();
      const Factory = await ethers.getContractFactory("ArticleActions");
      await expect(
        Factory.deploy(await token.getAddress(), await registry.getAddress(), ethers.ZeroAddress, 250n),
      ).to.be.revertedWithCustomError(Factory, "BadParams");
      await expect(
        Factory.deploy(ethers.ZeroAddress, await registry.getAddress(), (await ethers.getSigners())[4].address, 250n),
      ).to.be.revertedWithCustomError(Factory, "BadParams");
      await expect(
        Factory.deploy(
          await token.getAddress(),
          await registry.getAddress(),
          (await ethers.getSigners())[4].address,
          1001n,
        ),
      ).to.be.revertedWithCustomError(Factory, "BadParams");
    });

    it("pause blocks every action; unpause restores them", async () => {
      const { owner, reader, actions, articleId } = await deploy();
      await actions.connect(owner).pause();
      await expect(actions.connect(reader).like(articleId)).to.be.revertedWithCustomError(actions, "EnforcedPause");
      await expect(actions.connect(reader).tip(articleId, 1n)).to.be.revertedWithCustomError(actions, "EnforcedPause");
      await actions.connect(owner).unpause();
      await actions.connect(reader).like(articleId); // works again
    });

    it("the contract never holds a token balance", async () => {
      const { reader, reader2, token, actions, actionsAddr, articleId } = await deploy();
      await actions.connect(reader).like(articleId);
      await actions.connect(reader).dislike(articleId);
      await actions.connect(reader).reply(articleId, "hi");
      await actions.connect(reader2).tip(articleId, ethers.parseEther("5"));
      expect(await token.balanceOf(actionsAddr)).to.equal(0n);
    });
  });

  describe("reentrancy", () => {
    it("a token that re-enters an action during transferFrom is blocked by nonReentrant", async () => {
      const [owner, author, reader, treasury] = await ethers.getSigners();
      const registry = await (await ethers.getContractFactory("ArticleRegistry")).deploy();
      const evil = await (await ethers.getContractFactory("ReentrantERC20")).deploy();
      const actions = await (await ethers.getContractFactory("ArticleActions")).deploy(
        await evil.getAddress(),
        await registry.getAddress(),
        treasury.address,
        FEE_BPS,
      );
      const actionsAddr = await actions.getAddress();
      await registry.connect(author).publish(HASH, "m"); // article 1
      await registry.connect(author).publish(HASH, "m"); // article 2
      await evil.mint(reader.address, ethers.parseEther("100"));
      await evil.connect(reader).approve(actionsAddr, ethers.MaxUint256);

      // during the transferFrom triggered by like(1), the token re-enters like(2)
      await evil.arm(actionsAddr, actions.interface.encodeFunctionData("like", [2n]));

      await actions.connect(reader).like(1n); // outer call succeeds
      expect(await evil.reenteredOnce()).to.equal(true);
      expect(await evil.reentrySucceeded()).to.equal(false); // guard rejected the reentry
      expect(await actions.likeCount(1n)).to.equal(1n);
      expect(await actions.likeCount(2n)).to.equal(0n);
      void owner;
    });
  });

  describe("independence from AttentionStream", () => {
    it("likes/tips during a live session do not perturb session accounting", async () => {
      const [owner, author, reader, treasury] = await ethers.getSigners();
      const registry = await (await ethers.getContractFactory("ArticleRegistry")).deploy();
      const token = await (await ethers.getContractFactory("MockERC20")).deploy();
      const stream = await (await ethers.getContractFactory("AttentionStream")).deploy(
        await token.getAddress(),
        await registry.getAddress(),
        treasury.address,
        FEE_BPS,
      );
      const actions = await (await ethers.getContractFactory("ArticleActions")).deploy(
        await token.getAddress(),
        await registry.getAddress(),
        treasury.address,
        FEE_BPS,
      );
      await registry.connect(author).publish(HASH, "m");
      const articleId = 1n;
      await token.mint(reader.address, ethers.parseEther("1000"));
      await token.connect(reader).approve(await stream.getAddress(), ethers.MaxUint256);
      await token.connect(reader).approve(await actions.getAddress(), ethers.MaxUint256);

      const RATE = 1_000_000_000_000_000n;
      const BUDGET = 30n * RATE;
      const sessionKey = ethers.Wallet.createRandom();
      const openRc = await (
        await stream.connect(reader).openSession(articleId, BUDGET, RATE, sessionKey.address)
      ).wait();
      const opened = openRc!.logs
        .map((l) => {
          try {
            return stream.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e?.name === "SessionOpened");
      const sessionId: string = opened!.args.id;

      // interleave discrete actions
      await actions.connect(reader).like(articleId);
      await actions.connect(reader).tip(articleId, ethers.parseEther("3"));
      await time.increase(30);

      // settle the session
      const cumulative = 5n * RATE;
      const domain = {
        name: "AttentionStream",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await stream.getAddress(),
      };
      const types = { Voucher: [{ name: "sessionId", type: "bytes32" }, { name: "cumulativeAmount", type: "uint256" }] };
      const sig = await sessionKey.signTypedData(domain, types, { sessionId, cumulativeAmount: cumulative });
      await stream.connect(author).settle(sessionId, cumulative, sig);

      const s = await stream.sessions(sessionId);
      expect(s.claimed).to.equal(cumulative); // exactly what the voucher says — unaffected by the likes
      expect(await stream.articleEarned(articleId)).to.equal(cumulative);
      void owner;
    });
  });
});
