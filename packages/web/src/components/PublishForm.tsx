"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { decodeEventLog } from "viem";
import { useAccount, usePublicClient, useSignMessage, useWriteContract } from "wagmi";
import {
  ARTICLE_REGISTRY,
  CHAIN_ID,
  COLLECTOR_URL,
  DEFAULT_TIER_ID,
  RATE_TIERS,
  articleRegistryAbi,
  type RateTierId,
} from "@/lib/chain";
import { encryptBody, randomKeyB64 } from "@/lib/crypto";
import { MAX_BODY_CHARS, contentHashOf, encodeMetadataURI, previewOf } from "@/lib/metadata";
import { costForMinutes, tierById } from "@/lib/rate";
import { useHydrated } from "@/lib/useHydrated";

export function PublishForm() {
  const router = useRouter();
  const hydrated = useHydrated();
  const { isConnected, chainId, address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync, isPending } = useWriteContract();
  const { signMessageAsync } = useSignMessage();

  const [title, setTitle] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [body, setBody] = useState("");
  const [tierId, setTierId] = useState<RateTierId>(DEFAULT_TIER_ID);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (address && !authorName) setAuthorName("");
  }, [address, authorName]);

  const onChain = hydrated && isConnected && chainId === CHAIN_ID;
  const tooLong = body.length > MAX_BODY_CHARS;
  const canSubmit = onChain && title.trim() && body.trim() && !tooLong && !isPending;

  async function submit() {
    setError(null);
    try {
      // contentHash still commits to the plaintext (integrity / authorship proof).
      const contentHash = contentHashOf(body);

      setStatus("Encrypting…");
      const key = randomKeyB64();
      const enc = await encryptBody(body, key);
      const meta = {
        title: title.trim(),
        authorName: authorName.trim() || undefined,
        createdAt: Math.floor(Date.now() / 1000),
        ratePerMinute: tierById(tierId).perMinute,
        preview: previewOf(body),
        enc,
      };
      const uri = encodeMetadataURI(meta);

      // Register the key with the collector BEFORE publishing — so there's no
      // "published but unreadable" gap if the author bails after the tx.
      setStatus("Sign to register the decryption key…");
      const keySig = await signMessageAsync({
        message: `attention-press: register key for ${contentHash.toLowerCase()}`,
      });
      setStatus("Registering key with the content service…");
      const keyRes = await fetch(`${COLLECTOR_URL}/articles/key`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contentHash, key, signature: keySig }),
      });
      if (!keyRes.ok) {
        throw new Error(`key registration failed: ${(await keyRes.json().catch(() => ({}))).reason ?? keyRes.status}`);
      }

      setStatus("Confirm the publish in your wallet…");
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
        The body is AES-encrypted before it goes on-chain; readers get the key only while a paid session is
        open. A short preview stays public. <strong>The content service (collector) holds the key and can
        technically read the article</strong> — run your own for full confidentiality.
      </p>

      {hydrated && !isConnected && <p className="notice">Connect your wallet to publish.</p>}
      {hydrated && isConnected && chainId !== CHAIN_ID && (
        <p className="notice">Switch to Monad Testnet to publish.</p>
      )}

      <label htmlFor="t">Title</label>
      <input id="t" type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="On slow reading" />

      <label htmlFor="an">Author name (optional)</label>
      <input id="an" type="text" value={authorName} onChange={(e) => setAuthorName(e.target.value)} placeholder="shown on the article" />

      <label htmlFor="b">
        Body (Markdown) — {body.length.toLocaleString()} / {MAX_BODY_CHARS.toLocaleString()} chars
      </label>
      <textarea id="b" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write something worth someone's attention…" />
      {tooLong && <p className="notice err">Body is over {MAX_BODY_CHARS.toLocaleString()} chars — trim it to keep the publish tx affordable.</p>}

      <label>Reading pays the author</label>
      <div className="tier-select">
        {RATE_TIERS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tier${tierId === t.id ? " tier-on" : ""}`}
            onClick={() => setTierId(t.id)}
          >
            <b>{t.label}</b>
            <span>{t.perMinute} WMON/min</span>
          </button>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        ≈ {costForMinutes(tierById(tierId).perMinute, 10)} WMON for a 10-minute read · session capped at 30 min
      </p>

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
