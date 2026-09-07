import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

// Billing is scaffolded but OFF by default — early beta is free. Flip
// BILLING_ENABLED=true in your .env once you're ready to start charging.
// The actual gate lives in app/routes/app.tsx's loader (it calls
// `billing.require(...)` there, which runs on every embedded page since
// app.tsx is the shared layout for all of /app/*) — flipping this alone
// doesn't charge anyone, it just turns that check on or off.
export const BILLING_ENABLED = process.env.BILLING_ENABLED === "true";

// Safety default: ALWAYS test mode (no real card is ever charged) unless
// someone deliberately sets BILLING_TEST_MODE=false in .env / a Fly.io
// secret. This is the toggle for testing the billing flow end-to-end on
// the dev store without worrying about a real charge. Flip it off only
// when you're intentionally testing a real production charge on a store
// with a real payment method attached.
export const BILLING_TEST_MODE = process.env.BILLING_TEST_MODE !== "false";

export const LEAKAUDIT_PLAN = "LeakAudit Pro Plan";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
  // The billing PLAN is always configured, whether or not BILLING_ENABLED
  // is on — configuring a plan never charges anyone by itself. What
  // BILLING_ENABLED actually controls is whether app.tsx's loader calls
  // `billing.require(...)` to enforce it. Change the amount below to 39
  // if you'd rather launch at $39/mo instead of $49/mo.
  billing: {
    [LEAKAUDIT_PLAN]: {
      lineItems: [
        {
          amount: 49,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
      trialDays: 14,
    },
  },
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
