"use client";

import { useEffect, useState } from "react";

/**
 * `false` during SSR and the first client render, `true` after mount.
 *
 * Gate any wallet-dependent UI behind this: wagmi (configured with `ssr: false`)
 * has no connection state on the server but reconnects from storage synchronously
 * on the client, so rendering connected state before mount causes a hydration
 * mismatch.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
