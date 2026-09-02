"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getAddress, isAddress } from "viem";
import { useAccount, useReadContract, useSignMessage } from "wagmi";
import { ATTENTION_STREAM, COLLECTOR_URL, attentionStreamAbi, erc20Abi } from "@/lib/chain";
import { formatUnits, shortAddress } from "@/lib/format";
import { useArticles } from "@/lib/articles";
import { useHydrated } from "@/lib/useHydrated";

const BIO_MAX = 280;

interface ReaderStats {
  totalPaid: string;
  sessionsOpened: number;
  articlesRead: number;
}

export function ProfileClient({ address: raw }: { address: string }) {
  const hydrated = useHydrated();
  const { address: connected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const valid = isAddress(raw);
  const address = valid ? getAddress(raw) : "0x0000000000000000000000000000000000000000";
  const isMe = valid && hydrated && !!connected && getAddress(connected) === address;

  const { articles, isLoading } = useArticles();
  const mine = articles.filter((a) => a.author.toLowerCase() === address.toLowerCase() && !a.retired);
  const totalEarned = mine.reduce((s, a) => s + a.earned, 0n);

  const token = useReadContract({ address: ATTENTION_STREAM, abi: attentionStreamAbi, functionName: "token" });
  const symbol = useReadContract({ address: token.data, abi: erc20Abi, functionName: "symbol", query: { enabled: !!token.data } });
  const decimals = useReadContract({ address: token.data, abi: erc20Abi, functionName: "decimals", query: { enabled: !!token.data } });
  const sym = symbol.data ?? "WMON";
  const dec = decimals.data ?? 18;

  const [stats, setStats] = useState<ReaderStats | null>(null);
  const [bio, setBio] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [collectorUp, setCollectorUp] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!valid) return;
    let live = true;
    (async () => {
      try {
        const [s, p] = await Promise.all([
          fetch(`${COLLECTOR_URL}/readers/${address}/stats`).then((r) => r.json()),
          fetch(`${COLLECTOR_URL}/profiles/${address}`).then((r) => r.json()),
        ]);
        if (!live) return;
        setStats(s);
        setBio(typeof p.text === "string" ? p.text : "");
      } catch {
        if (live) setCollectorUp(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [address, valid]);

  const saveBio = useCallback(async () => {
    if (draft === null) return;
    setSaving(true);
    setMsg(null);
    try {
      const text = draft.slice(0, BIO_MAX);
      const signature = await signMessageAsync({
        message: `attention-press: set bio for ${address.toLowerCase()}\n\n${text}`,
      });
      const res = await fetch(`${COLLECTOR_URL}/profiles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, text, signature }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).reason ?? `collector ${res.status}`);
      setBio(text);
      setDraft(null);
      setMsg("Saved.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [draft, address, signMessageAsync]);

  if (!valid) return <p className="notice err">Not a valid address.</p>;

  return (
    <>
      <h1>{shortAddress(address)}</h1>
      <p className="lede">
        <code>{address}</code>
      </p>

      {/* Bio */}
      <section>
        <h2>Bio</h2>
        {!collectorUp && <p className="notice">Bio service (collector) unreachable.</p>}
        {draft === null ? (
          <p className={bio ? "" : "muted"}>
            {bio || "No bio yet."}
            {isMe && collectorUp && (
              <button className="btn btn-ghost" style={{ marginLeft: 10 }} onClick={() => setDraft(bio)}>
                Edit
              </button>
            )}
          </p>
        ) : (
          <>
            <textarea
              value={draft}
              maxLength={BIO_MAX}
              onChange={(e) => setDraft(e.target.value)}
              style={{ minHeight: 90 }}
              placeholder="A sentence or two about what you write."
            />
            <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
              <button className="btn btn-primary" disabled={saving} onClick={saveBio}>
                {saving ? "Sign & saving…" : "Save"}
              </button>
              <button className="btn btn-ghost" disabled={saving} onClick={() => setDraft(null)}>
                Cancel
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                {draft.length}/{BIO_MAX} · one wallet signature, no gas
              </span>
            </div>
          </>
        )}
        {msg && <p className="muted" style={{ fontSize: 13 }}>{msg}</p>}
      </section>

      {/* As an author */}
      <section>
        <h2>
          Published{" "}
          <span className="muted">
            · {mine.length} article{mine.length === 1 ? "" : "s"} · {formatUnits(totalEarned, dec)} {sym} earned
          </span>
        </h2>
        {isLoading && <p className="muted">Loading…</p>}
        {!isLoading && mine.length === 0 && <p className="muted">Nothing published from this address.</p>}
        <div className="grid">
          {mine.map((a) => (
            <Link key={a.id.toString()} href={`/article/${a.id}`} className="card">
              <h3>{a.metadata?.title ?? `Article #${a.id}`}</h3>
              <div className="card-meta">
                <span>💰 {formatUnits(a.earned, dec)} {sym}</span>
                <span>👁 {a.sessions}</span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* As a reader */}
      <section>
        <h2>Reading</h2>
        {!collectorUp ? (
          <p className="muted">Reader stats need the collector.</p>
        ) : !stats ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="card-meta" style={{ fontSize: 14 }}>
            <span>
              <b>{formatUnits(BigInt(stats.totalPaid), dec)} {sym}</b> paid to authors
            </span>
            <span>
              <b>{stats.sessionsOpened}</b> sessions
            </span>
            <span>
              <b>{stats.articlesRead}</b> articles read
            </span>
          </div>
        )}
        <p className="muted" style={{ fontSize: 12 }}>
          Counts sessions settled through this collector.
        </p>
      </section>
    </>
  );
}
