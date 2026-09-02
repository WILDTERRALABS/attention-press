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
    <html lang="en">
      <body>
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
