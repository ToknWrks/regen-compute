/**
 * HD wallet derivation for subscriber Regen addresses.
 *
 * Each subscriber gets a deterministic Regen address derived from the
 * master wallet mnemonic using HD path m/44'/118'/0'/0/{subscriberId}.
 * These addresses are passive — they never need REGEN for gas.
 * Credits are sent-and-retired to them by the master wallet via MsgSend.
 */

import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { stringToPath } from "@cosmjs/crypto";
import { loadConfig } from "../config.js";

/** Cache derived addresses to avoid repeated HD derivation */
const addressCache = new Map<number, string>();

/**
 * Derive a subscriber's Regen address from the master mnemonic.
 * Uses HD path m/44'/118'/0'/0/{subscriberId} for deterministic derivation.
 */
export async function deriveSubscriberAddress(subscriberId: number): Promise<string> {
  const cached = addressCache.get(subscriberId);
  if (cached) return cached;

  const config = loadConfig();
  if (!config.walletMnemonic) {
    throw new Error("REGEN_WALLET_MNEMONIC is not configured — cannot derive subscriber addresses");
  }

  const hdPath = stringToPath(`m/44'/118'/0'/0/${subscriberId}`);
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(config.walletMnemonic, {
    prefix: "regen",
    hdPaths: [hdPath],
  });

  const [account] = await wallet.getAccounts();
  addressCache.set(subscriberId, account.address);
  return account.address;
}

/** Clear the address cache (useful for testing). */
export function clearAddressCache(): void {
  addressCache.clear();
}
