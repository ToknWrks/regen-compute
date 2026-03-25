/**
 * x402 Payment Protocol middleware for the Developer API.
 *
 * Adds standards-compliant HTTP 402 payment flow alongside the existing
 * custom 402 and API key authentication. When X402_ENABLED=true:
 *
 * 1. Requests with a valid API key → pass through (existing auth, untouched)
 * 2. Requests with a `payment-signature` header → x402 verify+settle via facilitator
 * 3. Unauthenticated requests → x402 402 response with payment requirements
 *
 * After successful x402 payment, the afterSettle hook provisions a user +
 * subscriber and includes the API key in a custom response header so the
 * agent can reuse it for subsequent calls without paying again.
 */

import type Database from "better-sqlite3";
import {
  paymentMiddlewareFromHTTPServer,
  x402ResourceServer,
  x402HTTPResourceServer,
  type PaywallConfig,
} from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  getUserByApiKey,
  createUser,
  createSubscriber,
  type User,
} from "./db.js";
import { deriveSubscriberAddress } from "../services/subscriber-wallet.js";

// --- Constants ---

const EVM_PAY_TO = "0x0687cC26060FE12Fd4A6210c2f30Cf24a9853C6b";

// Default Coinbase CDP facilitator (mainnet)
const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";

// CAIP-2 network identifiers
const BASE_MAINNET = "eip155:8453" as const;

// Pricing in USD (passed as "$X.XX" to x402 which converts to USDC amounts)
// Use the Agent tier ($5/mo) as the per-request equivalent for x402 micropayments.
// At 100 requests/day = ~3000/mo, $5/3000 ≈ $0.0017/request. Round to $0.01 for simplicity.
const PRICE_PER_REQUEST = "$0.01";

// --- Protected route patterns ---
// These match the routes behind the auth middleware in api-routes.ts.
// Public endpoints (openapi.json, payment-info, confirm-payment) are NOT included.

const PROTECTED_ROUTES: Record<string, { description: string; mimeType: string }> = {
  "POST /api/v1/retire": {
    description: "Retire verified ecological credits on Regen Network",
    mimeType: "application/json",
  },
  "GET /api/v1/credits": {
    description: "Browse available ecological credits with live pricing",
    mimeType: "application/json",
  },
  "GET /api/v1/footprint": {
    description: "Estimate ecological footprint of an AI session",
    mimeType: "application/json",
  },
  "GET /api/v1/certificates/*": {
    description: "Retrieve on-chain retirement certificate",
    mimeType: "application/json",
  },
  "GET /api/v1/impact": {
    description: "Get Regen Network aggregate impact statistics",
    mimeType: "application/json",
  },
  "GET /api/v1/subscription": {
    description: "Check subscription status and cumulative impact",
    mimeType: "application/json",
  },
};

// --- Middleware factory ---

export interface X402MiddlewareOptions {
  db: Database.Database;
  baseUrl: string;
  facilitatorUrl?: string;
}

export function createX402Middleware(options: X402MiddlewareOptions) {
  const { db, baseUrl } = options;
  const facilitatorUrl =
    process.env.X402_FACILITATOR_URL ||
    options.facilitatorUrl ||
    DEFAULT_FACILITATOR_URL;

  // --- Build route config ---
  // Build as a plain object then assert the type to satisfy RoutesConfig union
  const routesConfig: Record<string, unknown> = {};

  for (const [pattern, meta] of Object.entries(PROTECTED_ROUTES)) {
    routesConfig[pattern] = {
      accepts: [
        {
          scheme: "exact",
          price: PRICE_PER_REQUEST,
          network: BASE_MAINNET,
          payTo: EVM_PAY_TO,
          maxTimeoutSeconds: 60,
        },
      ],
      description: meta.description,
      mimeType: meta.mimeType,
    };
  }

  // --- Create facilitator client ---
  const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

  // --- Create resource server with EVM scheme ---
  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(BASE_MAINNET, new ExactEvmScheme());

  // --- After-settle hook: provision user + subscriber ---
  resourceServer.onAfterSettle(async (context) => {
    const { paymentPayload, result } = context;
    if (!result.success) return;

    const payer = result.payer || paymentPayload.payload?.from as string || "unknown";
    const network = result.network;
    const txHash = result.transaction;

    // Find or create user by payer address
    // Check if this payer already has an account
    const existingPayment = db.prepare(
      "SELECT user_id FROM crypto_payments WHERE from_address = ? AND user_id IS NOT NULL AND status = 'provisioned' LIMIT 1"
    ).get(payer) as { user_id: number } | undefined;

    let user: User | undefined;
    if (existingPayment) {
      user = db.prepare("SELECT * FROM users WHERE id = ?").get(existingPayment.user_id) as User | undefined;
    }

    if (!user) {
      user = createUser(db, null, null);
    }

    // Calculate subscription: $0.01 per request, treat as 1-month minimum
    const usdCents = 1; // $0.01
    const plan = "dabbler";
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    const subId = `x402_${network}_${txHash.slice(0, 16)}`;

    // Check if subscriber already exists for this tx (idempotency)
    const existingSub = db.prepare(
      "SELECT id FROM subscribers WHERE stripe_subscription_id = ?"
    ).get(subId) as { id: number } | undefined;

    if (!existingSub) {
      const subscriber = createSubscriber(
        db, user.id,
        subId,
        plan, usdCents,
        now.toISOString(), periodEnd.toISOString(),
        "monthly"
      );

      // Derive Regen address
      try {
        const regenAddr = await deriveSubscriberAddress(subscriber.id);
        db.prepare("UPDATE subscribers SET regen_address = ? WHERE id = ?").run(regenAddr, subscriber.id);
      } catch { /* non-critical */ }

      // Record as crypto payment
      try {
        db.prepare(
          "INSERT INTO crypto_payments (chain, tx_hash, from_address, token, amount, usd_value_cents, status, user_id) VALUES (?, ?, ?, ?, ?, ?, 'provisioned', ?)"
        ).run(network, txHash, payer, "USDC", "0.01", usdCents, user.id);
      } catch { /* may fail on unique constraint if already recorded */ }

      // Front-load burn budget (5% of payment)
      const burnBudgetCents = Math.max(1, Math.floor(usdCents * 0.05));
      try {
        db.prepare(
          "INSERT INTO burn_accumulator (amount_cents, source_type, subscriber_id) VALUES (?, 'crypto_payment', ?)"
        ).run(burnBudgetCents, subscriber.id);
      } catch { /* non-critical */ }
    }

    console.log(`x402 payment settled: ${payer} on ${network} tx ${txHash.slice(0, 16)}... → user ${user.id}`);
  });

  // --- Create HTTP server with protected request hook ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const httpServer = new x402HTTPResourceServer(resourceServer, routesConfig as any);

  // Hook: bypass payment for requests with valid API key
  httpServer.onProtectedRequest(async (context) => {
    const authHeader = context.adapter.getHeader("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return; // No API key → continue to x402 payment flow
    }

    const apiKey = authHeader.slice(7).trim();
    const user = getUserByApiKey(db, apiKey);
    if (user) {
      return { grantAccess: true }; // Valid API key → skip payment
    }

    // Invalid API key → continue to x402 payment flow (don't reject outright,
    // let x402 give them a chance to pay)
    return;
  });

  // --- Build Express middleware ---
  const paywallConfig: PaywallConfig = {
    appName: "Regenerative Compute",
    appLogo: `${baseUrl}/logo.svg`,
  };

  const middleware = paymentMiddlewareFromHTTPServer(
    httpServer,
    paywallConfig,
    undefined, // default paywall provider
    true, // sync facilitator on start
  );

  return middleware;
}
