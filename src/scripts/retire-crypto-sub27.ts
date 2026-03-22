/**
 * One-off script: Execute first retirement for crypto subscriber 27.
 *
 * - Fix regen_address to match sub 3 (christian@regen.network's original)
 * - Execute month 1 retirement: $12.94 yearly (gross = net, no Stripe fees)
 *
 * Usage: node --loader ts-node/esm src/scripts/retire-crypto-sub27.ts [--dry-run]
 *    or: npx tsx src/scripts/retire-crypto-sub27.ts [--dry-run]
 */

import { getDb, setSubscriberRegenAddress } from "../server/db.js";
import { retireForSubscriber } from "../services/retire-subscriber.js";

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const db = getDb();

  // 1. Get sub 3's regen_address (christian's original subscription)
  const sub3 = db.prepare("SELECT regen_address FROM subscribers WHERE id = 3").get() as { regen_address: string } | undefined;
  if (!sub3?.regen_address) {
    throw new Error("Sub 3 has no regen_address!");
  }
  const regenAddress = sub3.regen_address;
  console.log(`Christian's Regen address (from sub 3): ${regenAddress}`);

  // 2. Fix sub 27's regen_address to match
  setSubscriberRegenAddress(db, 27, regenAddress);
  console.log(`Set regen_address on subscriber 27 to ${regenAddress}`);

  // 3. Execute month 1 retirement
  // $12.94 total, 2 months scheduled → $6.47/month gross
  // Crypto = no Stripe fees, so net = gross
  const grossCents = 647;
  console.log(`\n=== Subscriber 27: $${(grossCents / 100).toFixed(2)} yearly (month 1 of 2) ===`);

  const result = await retireForSubscriber({
    subscriberId: 27,
    grossAmountCents: grossCents,
    billingInterval: "yearly",
    precomputedNetCents: grossCents, // no Stripe fees for crypto
    paymentId: "crypto-sub27-month1",
    overrideAddress: regenAddress,
    dryRun,
  });

  console.log(`Status: ${result.status}`);
  console.log(`Credits retired: ${result.totalCreditsRetired}`);
  console.log(`Spent: $${(result.totalSpentCents / 100).toFixed(2)}`);
  if (result.errors.length > 0) console.log(`Errors: ${result.errors.join(", ")}`);
  for (const b of result.batches) {
    console.log(`  ${b.batchDenom}: ${b.creditsRetired} credits, tx=${b.buyTxHash ?? b.sendRetireTxHash ?? "none"}`);
  }

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
