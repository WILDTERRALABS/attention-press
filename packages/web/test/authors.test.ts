import { describe, expect, it } from "vitest";
import { groupAuthors } from "../src/lib/authors";
import type { ArticleView } from "../src/lib/articles";

function article(over: Partial<ArticleView>): ArticleView {
  return {
    id: 1n,
    author: "0xAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaA",
    contentHash: "0x0",
    createdAt: 0,
    retired: false,
    metadata: null,
    rawMetadataURI: "",
    earned: 0n,
    readerSeconds: 0n,
    sessions: 0,
    ...over,
  } as ArticleView;
}

const A = "0xAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaA" as const;
const B = "0xBbBbbBBbBbbBBbBbbbBBbBbbbbBbBbbbBBbBbBbBb" as const;

describe("groupAuthors", () => {
  it("aggregates per author and sorts by total earned desc", () => {
    const authors = groupAuthors([
      article({ id: 1n, author: A, earned: 3n, readerSeconds: 100n, createdAt: 10 }),
      article({ id: 2n, author: A, earned: 4n, readerSeconds: 50n, createdAt: 20 }),
      article({ id: 3n, author: B, earned: 10n, readerSeconds: 5n, createdAt: 5 }),
    ]);
    expect(authors.map((x) => x.address)).toEqual([B, A]); // B earned 10 > A earned 7
    const a = authors.find((x) => x.address === A)!;
    expect(a.articleCount).toBe(2);
    expect(a.totalEarned).toBe(7n);
    expect(a.totalReaderSeconds).toBe(150n);
    expect(a.latestCreatedAt).toBe(20);
  });

  it("skips retired articles", () => {
    const authors = groupAuthors([
      article({ author: A, earned: 5n }),
      article({ author: A, earned: 99n, retired: true }),
    ]);
    expect(authors[0]!.totalEarned).toBe(5n);
    expect(authors[0]!.articleCount).toBe(1);
  });

  it("takes authorName from the most recent article that has one", () => {
    const authors = groupAuthors([
      article({ author: A, createdAt: 10, metadata: { title: "t", createdAt: 10, authorName: "Old Name", body: "x" } }),
      article({ author: A, createdAt: 30, metadata: { title: "t", createdAt: 30, authorName: "New Name", body: "x" } }),
      article({ author: A, createdAt: 40, metadata: { title: "t", createdAt: 40, body: "x" } }), // no name, newest
    ]);
    expect(authors[0]!.authorName).toBe("New Name");
  });

  it("does not leak the internal _nameAt field", () => {
    const [a] = groupAuthors([article({ author: A })]);
    expect(Object.keys(a!)).not.toContain("_nameAt");
  });
});
