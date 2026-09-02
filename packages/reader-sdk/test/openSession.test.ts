import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, toEventSelector, type Hex } from "viem";
import { attentionStreamAbi } from "../src/chain/abi.js";

const CONTRACT = "0x00000000000000000000000000000000000000AA";
const READER = "0x1111111111111111111111111111111111111111";
const AUTHOR = "0x2222222222222222222222222222222222222222";
const SIGNER = "0x3333333333333333333333333333333333333333";

const state = {
  allowance: 10n ** 30n,
  receiptStatus: "reverted" as "reverted" | "success",
  logs: [] as unknown[],
};

vi.mock("../src/chain/client.js", () => ({
  makeClients: () => ({
    publicClient: {
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === "token" ? "0x00000000000000000000000000000000000000BB" : state.allowance,
      waitForTransactionReceipt: async () => ({ status: state.receiptStatus, logs: state.logs }),
    },
    walletClient: { writeContract: async () => "0xdeadbeef" as Hex },
  }),
  requireAccount: async () => READER,
}));

const { openSession } = await import("../src/chain/openSession.js");

const params = {
  provider: { request: async () => undefined },
  chainId: 10143,
  contractAddress: CONTRACT as `0x${string}`,
  articleId: 1n,
  budget: 1_000_000n,
  ratePerSec: 1_000n,
  signer: SIGNER as `0x${string}`,
  skipApproval: true,
};

function sessionOpenedLog(id: Hex) {
  const topic0 = toEventSelector("SessionOpened(bytes32,uint256,address,address,address,uint96,uint64)");
  const pad = (a: string) => ("0x" + a.slice(2).padStart(64, "0")) as Hex;
  return {
    address: CONTRACT,
    topics: [topic0, id, pad("0x1"), pad(READER)],
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint96" }, { type: "uint64" }],
      [AUTHOR, SIGNER, 1_000_000n, 1_000n],
    ),
  };
}

beforeEach(() => {
  state.allowance = 10n ** 30n;
  state.receiptStatus = "reverted";
  state.logs = [];
});

describe("openSession receipt handling", () => {
  it("throws a clear error when the transaction reverted", async () => {
    state.receiptStatus = "reverted";
    await expect(openSession(params)).rejects.toThrow(/reverted/i);
  });

  it("still reports 'event not found' when it succeeded but emitted nothing", async () => {
    state.receiptStatus = "success";
    state.logs = [];
    await expect(openSession(params)).rejects.toThrow(/SessionOpened event not found/);
  });

  it("returns the sessionId + author from a valid SessionOpened log", async () => {
    const id = ("0x" + "ab".repeat(32)) as Hex;
    state.receiptStatus = "success";
    state.logs = [sessionOpenedLog(id)];
    const res = await openSession(params);
    expect(res.sessionId).toBe(id);
    expect(res.author.toLowerCase()).toBe(AUTHOR.toLowerCase());
    expect(res.reader.toLowerCase()).toBe(READER.toLowerCase());
  });

  it("ignores logs from other contracts", async () => {
    const id = ("0x" + "cd".repeat(32)) as Hex;
    state.receiptStatus = "success";
    state.logs = [{ ...sessionOpenedLog(id), address: "0x9999999999999999999999999999999999999999" }];
    await expect(openSession(params)).rejects.toThrow(/SessionOpened event not found/);
  });
});
