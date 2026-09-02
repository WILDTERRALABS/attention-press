"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getAddress, isAddress } from "viem";
import { useAccount, useReadContract, useSignMessage } from "wagmi";
import { ArticleCard } from "@/components/ArticleCard";
import { useArticles } from "@/lib/articles";
import { ATTENTION_STREAM, COLLECTOR_URL, attentionStreamAbi, erc20Abi } from "@/lib/chain";
import { formatDuration, formatUnits, shortAddress } from "@/lib/format";
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
  const mine = useMemo(
    () => articles.filter((a) => a.author.toLowerCase() === address.toLowerCase() && !a.retired),
    [articles, address],
  );

  const token = useReadContract({ address: ATTENTION_STREAM, abi: attentionStreamAbi, functionName: "token" });
  const symbol = useReadContract({ address: token.data, abi: erc20Abi, functionName: "symbol", query: { enabled: !!token.data } });
  const decimals = useReadContract({ address: token.data, abi: erc20Abi, functionName: "decimals", query: { enabled: !!token.data } });
  const sym = symbol.data ?? "WMON";
  const dec = decimals.data ?? 18;

  const [sortBy, setSortBy] = useState<"newest" | "earned">("newest");
  const [stats, setStats] = useState<ReaderStats | null>(null);
  const [bio, setBio] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [collectorUp, setCollectorUp] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  const totals = useMemo(() => {
    let earned = 0n;
    let readerSeconds = 0n;
    let name: string | undefined;
    let nameAt = -1;
    for (const a of mine) {
      earned += a.earned;
      readerSeconds += a.readerSeconds;
      if (a.metadata?.authorName && a.createdAt >= nameAt) {
        name = a.metadata.authorName;
        nameAt = a.createdAt;
      }
    }
    return { earned, readerSeconds, name };
  }, [mine]);

  const sorted = useMemo(() => {
    const list = [...mine];
    list.sort((x, y) =>
      sortBy === "newest"
        ? y.createdAt - x.createdAt
        : y.earned > x.earned
          ? 1
          : y.earned < x.earned
            ? -1
            : 0,
    );
    return list;
  }, [mine, sortBy]);

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

  const displayName = totals.name ?? shortAddress(address);
  const nothingYet =
    !isLoading && mine.length === 0 && !bio && (!stats || stats.sessionsOpened === 0);

  return (
    <>
      {/* Header card */}
      <div className="card profile-header">
        <div className="profile-header-top">
          <div>
            <h1>{displayName}</h1>
            <code className="muted">{address}</code>
          </div>
          {isMe && collectorUp && draft === null && (
            <button className="btn btn-ghost" onClick={() => setDraft(bio)}>
              {bio ? "Edit bio" : "Add a bio"}
            </button>
          )}
        </div>

        {draft === null ? (
          bio ? (
            <p className="profile-bio">{bio}</p>
          ) : (
            <p className="muted profile-bio">No bio yet.</p>
          )
        ) : (
          <div className="profile-bio-edit">
            <textarea
              value={draft}
              maxLength={BIO_MAX}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="A sentence or two about what you write."
            />
            <div className="row-inline">
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
          </div>
        )}
        {msg && <p className="muted" style={{ fontSize: 13 }}>{msg}</p>}

        <div className="stat-row">
          <span>
            <b>{mine.length}</b> article{mine.length === 1 ? "" : "s"}
          </span>
          <span>
            <b>
              {formatUnits(totals.earned, dec)} {sym}
            </b>{" "}
            earned
          </span>
          <span>
            <b>{formatDuration(Number(totals.readerSeconds))}</b> reading time
          </span>
        </div>
      </div>

      {/* Articles */}
      <section>
        <div className="section-head">
          <h2>Articles</h2>
          <div className="sort-toggle">
            <button className={sortBy === "newest" ? "on" : ""} onClick={() => setSortBy("newest")}>
              Newest
            </button>
            <button className={sortBy === "earned" ? "on" : ""} onClick={() => setSortBy("earned")}>
              Most earned
            </button>
          </div>
        </div>
        {isLoading && <p className="muted">Loading…</p>}
        {!isLoading && mine.length === 0 && <p className="muted">Nothing published from this address.</p>}
        <div className="grid">
          {sorted.map((a) => (
            <ArticleCard key={a.id.toString()} a={a} tokenSymbol={sym} tokenDecimals={dec} />
          ))}
        </div>
      </section>

      {/* Reading */}
      <section>
        <h2>As a reader</h2>
        {!collectorUp ? (
          <p className="muted">Reader stats need the collector.</p>
        ) : !stats ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="card-meta" style={{ fontSize: 14 }}>
            <span>
              <b>
                {formatUnits(BigInt(stats.totalPaid), dec)} {sym}
              </b>{" "}
              paid to authors
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

      {nothingYet && <p className="muted">This address hasn&apos;t published or read anything yet.</p>}
    </>
  );
}
