/**
 * Recovery script: IBC LUNA from Regen → Osmosis, then swap LUNA → ATOM.
 *
 * The earlier burn test used the wrong REGEN_ON_OSMOSIS denom (was actually LUNA).
 * This sends the LUNA back to Osmosis and swaps it to ATOM.
 *
 * Usage: npx tsx src/scripts/recover-luna.ts [--live]
 */
import { SigningStargateClient, GasPrice, calculateFee } from "@cosmjs/stargate";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import {
  getSigningOsmosisClientOptions,
  osmosis,
} from "osmojs";
import type { EncodeObject } from "@cosmjs/proto-signing";
import { loadConfig } from "../config.js";

const LUNA_ON_REGEN = "ibc/815FC81EB6BD612206BD9A9909A02F7691D24A5B97CDFE2124B1BDCA9D4AB14C";
const LUNA_ON_OSMOSIS = "ibc/0EF15DF2F02480ADE0BB6E85D9EBB5DAEA2836D3860E9F97F9AADE4F57A31AA0";
const ATOM_ON_OSMOSIS = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";
const REGEN_TO_OSMOSIS_CHANNEL = "channel-1";
const OSMOSIS_RPC = process.env.OSMOSIS_RPC_URL || "https://rpc.osmosis.zone";
const REGEN_RPC = process.env.REGEN_RPC_URL || "http://mainnet.regen.network:26657";

const live = process.argv.includes("--live");

async function main() {
  console.log(`\n=== LUNA Recovery: Regen → Osmosis → ATOM — ${live ? "LIVE" : "DRY RUN"} ===\n`);

  const config = loadConfig();
  if (!config.walletMnemonic) throw new Error("No wallet mnemonic configured");

  // Init Regen wallet
  const regenWallet = await DirectSecp256k1HdWallet.fromMnemonic(config.walletMnemonic, { prefix: "regen" });
  const [regenAccount] = await regenWallet.getAccounts();
  const regenClient = await SigningStargateClient.connectWithSigner(REGEN_RPC, regenWallet, {
    gasPrice: GasPrice.fromString("0.025uregen"),
  });

  // Check LUNA balance on Regen
  const lunaBalance = await regenClient.getBalance(regenAccount.address, LUNA_ON_REGEN);
  const lunaAmount = Number(lunaBalance.amount) / 1e6;
  console.log(`LUNA on Regen (${regenAccount.address}): ${lunaAmount.toFixed(6)}`);

  if (lunaAmount <= 0) {
    console.log("No LUNA to recover.");
    return;
  }

  // Init Osmosis wallet
  const osmoWallet = await DirectSecp256k1HdWallet.fromMnemonic(config.walletMnemonic, { prefix: "osmo" });
  const [osmoAccount] = await osmoWallet.getAccounts();
  console.log(`Osmosis address: ${osmoAccount.address}`);

  // Step 1: IBC transfer LUNA from Regen → Osmosis
  const timeoutTimestamp = BigInt((Date.now() + 600_000) * 1_000_000); // 10 min

  const ibcMsg: EncodeObject = {
    typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
    value: {
      sourcePort: "transfer",
      sourceChannel: REGEN_TO_OSMOSIS_CHANNEL,
      token: { denom: LUNA_ON_REGEN, amount: lunaBalance.amount },
      sender: regenAccount.address,
      receiver: osmoAccount.address,
      timeoutHeight: { revisionNumber: BigInt(0), revisionHeight: BigInt(0) },
      timeoutTimestamp,
      memo: "",
    },
  };

  console.log(`\nStep 1: IBC transfer ${lunaAmount.toFixed(6)} LUNA → Osmosis...`);

  if (!live) {
    console.log("  [DRY RUN] Would IBC transfer LUNA to Osmosis");
  } else {
    const ibcGas = await regenClient.simulate(regenAccount.address, [ibcMsg], undefined);
    const ibcFee = calculateFee(Math.ceil(ibcGas * 1.5), GasPrice.fromString("0.025uregen"));
    const ibcTx = await regenClient.signAndBroadcast(regenAccount.address, [ibcMsg], ibcFee);
    if (ibcTx.code !== 0) throw new Error(`IBC failed (code ${ibcTx.code}): ${ibcTx.rawLog}`);
    console.log(`  IBC tx: ${ibcTx.transactionHash}`);

    // Wait for arrival on Osmosis
    console.log("  Waiting for IBC arrival on Osmosis (up to 120s)...");
    const clientOptions = getSigningOsmosisClientOptions();
    const osmoClient = await SigningStargateClient.connectWithSigner(OSMOSIS_RPC, osmoWallet, {
      registry: clientOptions.registry as any,
      aminoTypes: clientOptions.aminoTypes as any,
      gasPrice: GasPrice.fromString("0.035uosmo"),
    });

    let lunaOnOsmo = "0";
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 10_000));
      const bal = await osmoClient.getBalance(osmoAccount.address, LUNA_ON_OSMOSIS);
      if (BigInt(bal.amount) > 0n) {
        lunaOnOsmo = bal.amount;
        console.log(`  LUNA arrived on Osmosis: ${Number(lunaOnOsmo) / 1e6}`);
        break;
      }
    }

    if (lunaOnOsmo === "0") {
      console.log("  LUNA hasn't arrived yet. Check later and swap manually.");
      return;
    }

    // Step 2: Swap LUNA → ATOM on Osmosis
    console.log(`\nStep 2: Swap ${Number(lunaOnOsmo) / 1e6} LUNA → ATOM...`);

    // Get quote
    const quoteRes = await fetch(
      `https://sqsprod.osmosis.zone/router/quote?tokenIn=${lunaOnOsmo}${LUNA_ON_OSMOSIS}&tokenOutDenom=${ATOM_ON_OSMOSIS}`
    );
    const quote = await quoteRes.json() as { amount_out: string; route: any[] };
    const atomOut = Number(quote.amount_out) / 1e6;
    console.log(`  Quote: ${atomOut.toFixed(6)} ATOM`);

    const minOut = Math.floor(Number(quote.amount_out) * 0.97).toString(); // 3% slippage

    const swapMsg = osmosis.poolmanager.v1beta1.MessageComposer.withTypeUrl.splitRouteSwapExactAmountIn({
      sender: osmoAccount.address,
      routes: quote.route.map((r: any) => ({
        pools: r.pools.map((p: any) => ({
          poolId: BigInt(p.id),
          tokenOutDenom: p.token_out_denom,
        })),
        tokenInAmount: r.in_amount || lunaOnOsmo,
      })),
      tokenInDenom: LUNA_ON_OSMOSIS,
      tokenOutMinAmount: minOut,
    });

    const swapGas = await osmoClient.simulate(osmoAccount.address, [swapMsg as EncodeObject], undefined);
    const swapFee = calculateFee(Math.ceil(swapGas * 1.5), GasPrice.fromString("0.035uosmo"));
    const swapTx = await osmoClient.signAndBroadcast(osmoAccount.address, [swapMsg as EncodeObject], swapFee);
    if (swapTx.code !== 0) throw new Error(`Swap failed (code ${swapTx.code}): ${swapTx.rawLog}`);
    console.log(`  Swap tx: ${swapTx.transactionHash}`);

    // Check final ATOM balance
    const atomBal = await osmoClient.getBalance(osmoAccount.address, ATOM_ON_OSMOSIS);
    console.log(`\n✅ Recovery complete. ATOM balance on Osmosis: ${Number(atomBal.amount) / 1e6}`);
  }

  if (!live) {
    console.log("\nStep 2: [DRY RUN] Would swap LUNA → ATOM on Osmosis");
    console.log("\n✅ Dry run complete. Add --live to execute.");
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
