"use client";

import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { CHAIN_ID } from "@/lib/chain";
import { shortAddress } from "@/lib/format";

export function ConnectButton() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  if (!isConnected) {
    const injected = connectors[0];
    return (
      <button className="btn" disabled={!injected || isPending} onClick={() => injected && connect({ connector: injected })}>
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }

  if (chainId !== CHAIN_ID) {
    return (
      <button className="btn btn-warn" onClick={() => switchChain({ chainId: CHAIN_ID })}>
        Switch to Monad Testnet
      </button>
    );
  }

  return (
    <span className="wallet">
      <code>{address ? shortAddress(address) : ""}</code>
      <button className="btn btn-ghost" onClick={() => disconnect()}>
        Disconnect
      </button>
    </span>
  );
}
