import { describe, it, expect } from "vitest";
import {
  concatHex,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  type Hex,
} from "viem";
import { SessionKey } from "../src/session/SessionKey.js";
import { buildTypedData, VOUCHER_TYPES } from "../src/session/voucher.js";

const CONTRACT = "0x1111111111111111111111111111111111111111" as const;
const CHAIN_ID = 10143;
const SESSION_ID = ("0x" + "ab".repeat(32)) as Hex;

describe("voucher signing", () => {
  it("produces a signature that recovers to the session-key address", async () => {
    const key = SessionKey.generate();
    const message = { sessionId: SESSION_ID, cumulativeAmount: 123_456n };
    const signature = await key.signVoucher({ contractAddress: CONTRACT, chainId: CHAIN_ID, message });

    const recovered = await recoverTypedDataAddress({
      ...buildTypedData({ contractAddress: CONTRACT, chainId: CHAIN_ID, message }),
      signature,
    });
    expect(recovered.toLowerCase()).toBe(key.address.toLowerCase());
  });

  it("matches the exact digest AttentionStream._verify computes on-chain", () => {
    const message = { sessionId: SESSION_ID, cumulativeAmount: 999n };

    // Reconstruct Solidity's _hashTypedDataV4(keccak256(abi.encode(VOUCHER_TYPEHASH, id, amount))).
    const DOMAIN_TYPEHASH = keccak256(
      toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    );
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [
          DOMAIN_TYPEHASH,
          keccak256(toHex("AttentionStream")),
          keccak256(toHex("1")),
          BigInt(CHAIN_ID),
          CONTRACT,
        ],
      ),
    );
    const VOUCHER_TYPEHASH = keccak256(toHex("Voucher(bytes32 sessionId,uint256 cumulativeAmount)"));
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
        [VOUCHER_TYPEHASH, message.sessionId, message.cumulativeAmount],
      ),
    );
    const expected = keccak256(concatHex(["0x1901", domainSeparator, structHash]));

    const actual = hashTypedData({
      domain: { name: "AttentionStream", version: "1", chainId: CHAIN_ID, verifyingContract: CONTRACT },
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message,
    });

    expect(actual).toBe(expected);
  });

  it("destroyed keys refuse to sign", async () => {
    const key = SessionKey.generate();
    key.destroy();
    await expect(
      key.signVoucher({ contractAddress: CONTRACT, chainId: CHAIN_ID, message: { sessionId: SESSION_ID, cumulativeAmount: 1n } }),
    ).rejects.toThrow(/destroyed/);
  });
});
