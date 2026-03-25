/**
 * Manual burn test.
 * Usage: npx tsx src/scripts/test-burn.ts [--live] [--amount CENTS]
 *   --amount 100   = $1.00 (default)
 *   --amount pending = use full pending burn budget from DB
 */
import { swapAndBurn, checkOsmosisReadiness } from "../services/swap-and-burn.js";
import { getPendingBurnBudget, markBurnExecuted } from "../services/retire-subscriber.js";
import { getDb } from "../server/db.js";

const live = process.argv.includes("--live");
const amountArg = process.argv[process.argv.indexOf("--amount") + 1] || "100";

async function main() {
  let allocationCents: number;
  let markExecuted = false;

  if (amountArg === "pending") {
    const db = getDb();
    allocationCents = getPendingBurnBudget(db);
    markExecuted = true;
    if (allocationCents <= 0) {
      console.log("No pending burn budget.");
      return;
    }
    console.log(`\n=== REGEN Buy & Burn ($${(allocationCents / 100).toFixed(2)} pending) — ${live ? "LIVE" : "DRY RUN"} ===\n`);
  } else {
    allocationCents = parseInt(amountArg, 10);
    console.log(`\n=== REGEN Buy & Burn ($${(allocationCents / 100).toFixed(2)}) — ${live ? "LIVE" : "DRY RUN"} ===\n`);
  }

  const readiness = await checkOsmosisReadiness();
  console.log("Osmosis readiness:", JSON.stringify(readiness, null, 2));

  if (!readiness.ready) {
    console.error("Osmosis wallet not ready:", readiness.issues);
    process.exit(1);
  }

  const result = await swapAndBurn({
    allocationCents,
    swapDenom: readiness.usdcBalance >= allocationCents / 100
      ? "usdc"
      : readiness.atomBalance >= allocationCents / 100 / 10
        ? "atom"
        : "osmo",
    dryRun: !live,
  });

  console.log("\nResult:", JSON.stringify(result, null, 2));

  if (result.status === "completed") {
    console.log("\n✅ Burn complete!");
    console.log(`  Swap tx: ${result.swapTxHash}`);
    console.log(`  IBC tx: ${result.ibcTxHash}`);
    console.log(`  Burn tx: ${result.burnTxHash}`);
    console.log(`  REGEN burned: ${Number(result.burnAmountUregen) / 1e6}`);

    if (markExecuted && live) {
      const db = getDb();
      const maxId = (db.prepare("SELECT MAX(id) AS max_id FROM burn_accumulator WHERE executed = 0").get() as any)?.max_id;
      if (maxId) {
        markBurnExecuted(db, maxId);
        console.log(`  Marked accumulator entries up to id=${maxId} as executed.`);
      }
    }
  } else if (result.status === "partial") {
    console.log("\n⚠️  Partial — swap succeeded but IBC/burn may need manual completion");
  } else {
    console.log("\n❌ Failed:", result.errors);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
