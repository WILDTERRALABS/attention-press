import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ConnectButton } from "@/components/ConnectButton";
import { Providers } from "@/components/Providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "attention-press",
  description: "Reader-funded, pay-per-second publishing on Monad",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: wallet/other browser extensions mutate <html>/<body>
    // (attributes, injected nodes) before React hydrates. This only suppresses the
    // warning for these two elements' own attributes — not for our component tree.
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <Providers>
          <header className="site-header">
            <Link href="/" className="brand">
              attention<span>·</span>press
            </Link>
            <nav>
              <Link href="/publish" className="btn btn-ghost">
                Publish
              </Link>
              <ConnectButton />
            </nav>
          </header>
          <main className="container">{children}</main>
          <footer className="site-footer">
            Reader-funded, pay-per-second publishing · Monad testnet · engagement, not clicks
          </footer>
        </Providers>
      </body>
    </html>
  );
}
