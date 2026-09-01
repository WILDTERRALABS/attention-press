import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex, PrivateKeyAccount } from "viem";
import { VOUCHER_TYPES, VOUCHER_PRIMARY_TYPE, buildDomain, type VoucherMessage } from "./voucher.js";

/**
 * Ephemeral key that signs vouchers for one reading session.
 *
 * v0.1: in-memory only. The private key lives on this instance and nowhere else;
 * `destroy()` drops the reference (JS can't zero the string, but nothing else
 * holds it). A page reload loses the key — by design — so its blast radius is
 * bounded by the on-chain `budget` and `ratePerSec` of the session it was
 * registered for.
 */
export class SessionKey {
  readonly address: Address;
  private privateKey: Hex | null;
  private readonly account: PrivateKeyAccount;

  private constructor(privateKey: Hex) {
    this.privateKey = privateKey;
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
  }

  static generate(): SessionKey {
    return new SessionKey(generatePrivateKey());
  }

  get destroyed(): boolean {
    return this.privateKey === null;
  }

  async signVoucher(args: {
    contractAddress: Address;
    chainId: number;
    message: VoucherMessage;
  }): Promise<Hex> {
    if (this.privateKey === null) throw new Error("SessionKey has been destroyed");
    return this.account.signTypedData({
      domain: buildDomain(args),
      types: VOUCHER_TYPES,
      primaryType: VOUCHER_PRIMARY_TYPE,
      message: args.message,
    });
  }

  /** Irreversibly drop the key material. */
  destroy(): void {
    this.privateKey = null;
  }
}
