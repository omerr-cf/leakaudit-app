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
// ENABLE_BILLING=true in your .env once you're ready to start charging.
// Only fires require-billing checks where you explicitly call
// `billing.require(...)` in a route — adding this config alone doesn't
// charge anyone.
export const BILLING_ENABLED = process.env.ENABLE_BILLING === "true";
export const LEAKAUDIT_PLAN = "LeakAudit Monthly";

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
  ...(BILLING_ENABLED
    ? {
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
      }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
