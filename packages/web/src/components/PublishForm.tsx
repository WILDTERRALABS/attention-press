"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { decodeEventLog } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { ARTICLE_REGISTRY, CHAIN_ID, articleRegistryAbi } from "@/lib/chain";
import { MAX_BODY_CHARS, contentHashOf, encodeMetadataURI } from "@/lib/metadata";

export function PublishForm() {
  const router = useRouter();
  const { isConnected, chainId, address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync, isPending } = useWriteContract();

  const [title, setTitle] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (address && !authorName) setAuthorName("");
  }, [address, authorName]);

  const onChain = isConnected && chainId === CHAIN_ID;
  const tooLong = body.length > MAX_BODY_CHARS;
  const canSubmit = onChain && title.trim() && body.trim() && !tooLong && !isPending;

  async function submit() {
    setError(null);
    try {
      const meta = { title: title.trim(), authorName: authorName.trim() || undefined, body, createdAt: Math.floor(Date.now() / 1000) };
      const uri = encodeMetadataURI(meta);
      const contentHash = contentHashOf(body);

      setStatus("Confirm in your wallet…");
      const hash = await writeContractAsync({
        address: ARTICLE_REGISTRY,
        abi: articleRegistryAbi,
        functionName: "publish",
        args: [contentHash, uri],
      });

      setStatus("Publishing on-chain…");
      const receipt = await publicClient!.waitForTransactionReceipt({ hash });

      let newId: bigint | undefined;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== ARTICLE_REGISTRY.toLowerCase()) continue;
        try {
          const d = decodeEventLog({ abi: articleRegistryAbi, data: log.data, topics: log.topics });
          if (d.eventName === "Published") newId = (d.args as { id: bigint }).id;
        } catch {
          /* not Published */
        }
      }
      setStatus("Published!");
      router.push(newId ? `/article/${newId}` : "/");
    } catch (e) {
      setStatus(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <h1>Publish an article</h1>
      <p className="lede">
        Title and body are stored as an on-chain data URI (v1 — no IPFS pin needed). Readers stream payment
        per second while they read it.
      </p>

      {!isConnected && <p className="notice">Connect your wallet to publish.</p>}
      {isConnected && chainId !== CHAIN_ID && <p className="notice">Switch to Monad Testnet to publish.</p>}

      <label htmlFor="t">Title</label>
      <input id="t" type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="On slow reading" />

      <label htmlFor="an">Author name (optional)</label>
      <input id="an" type="text" value={authorName} onChange={(e) => setAuthorName(e.target.value)} placeholder="shown on the article" />

      <label htmlFor="b">
        Body (Markdown) — {body.length.toLocaleString()} / {MAX_BODY_CHARS.toLocaleString()} chars
      </label>
      <textarea id="b" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write something worth someone's attention…" />
      {tooLong && <p className="notice err">Body is over {MAX_BODY_CHARS.toLocaleString()} chars — trim it to keep the publish tx affordable.</p>}

      <div style={{ marginTop: 18 }}>
        <button className="btn btn-primary" disabled={!canSubmit} onClick={submit}>
          {isPending ? "Waiting for wallet…" : "Publish"}
        </button>
        {status && <span className="muted" style={{ marginLeft: 12 }}>{status}</span>}
      </div>

      {error && <p className="notice err" style={{ marginTop: 14 }}>{error}</p>}
    </>
  );
}
