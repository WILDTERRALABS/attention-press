import { describe, expect, it } from "vitest";
import { formatSeconds, formatUnits, shortAddress } from "../src/lib/format";
import { contentHashOf, decodeMetadataURI, encodeMetadataURI } from "../src/lib/metadata";

describe("format", () => {
  it("formatUnits trims trailing zeros and respects maxFrac", () => {
    expect(formatUnits(1_000_000_000_000_000_000n, 18)).toBe("1");
    expect(formatUnits(1_500_000_000_000_000_000n, 18)).toBe("1.5");
    expect(formatUnits(1_234_500_000_000_000_000n, 18, 2)).toBe("1.23");
    expect(formatUnits(0n, 18)).toBe("0");
    expect(formatUnits(-2_500_000_000_000_000_000n, 18)).toBe("-2.5");
  });

  it("shortAddress and formatSeconds", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
    expect(formatSeconds(45)).toBe("45s");
    expect(formatSeconds(135)).toBe("2m 15s");
  });
});

describe("metadata", () => {
  it("round-trips title + body through the data URI", () => {
    const meta = { title: "On slow reading", body: "# Hi\n\nSome *markdown* body — with unicode ✒️.", createdAt: 1_700_000_000 };
    const uri = encodeMetadataURI(meta);
    expect(uri.startsWith("data:application/json;base64,")).toBe(true);
    expect(decodeMetadataURI(uri)).toEqual({ ...meta, authorName: undefined });
  });

  it("returns null for non-data URIs", () => {
    expect(decodeMetadataURI("ipfs://bafyxyz")).toBeNull();
    expect(decodeMetadataURI("")).toBeNull();
  });

  it("contentHashOf is deterministic keccak of the body", () => {
    expect(contentHashOf("abc")).toBe(contentHashOf("abc"));
    expect(contentHashOf("abc")).not.toBe(contentHashOf("abd"));
    expect(contentHashOf("abc")).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
