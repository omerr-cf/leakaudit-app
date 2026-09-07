import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";

import {
  authenticate,
  BILLING_ENABLED,
  BILLING_TEST_MODE,
  LEAKAUDIT_PLAN,
} from "../shopify.server";

// This loader runs on EVERY embedded page (Home, History, Settings) since
// app.tsx is their shared layout — that makes it the one place to gate the
// whole app on billing instead of repeating the check in each route.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing } = await authenticate.admin(request);

  if (BILLING_ENABLED) {
    // A shop with no active LeakAudit Pro Plan subscription gets sent
    // straight to Shopify's native "approve this charge" screen; a shop
    // that already has one sails through untouched. BILLING_TEST_MODE
    // (see shopify.server.ts) keeps this from ever charging a real card
    // while you're testing.
    await billing.require({
      plans: [LEAKAUDIT_PLAN],
      isTest: BILLING_TEST_MODE,
      onFailure: async () =>
        billing.request({ plan: LEAKAUDIT_PLAN, isTest: BILLING_TEST_MODE }),
    });
  }

  // eslint-disable-next-line no-undef
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    billingEnabled: BILLING_ENABLED,
  };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/history">History</s-link>
        <s-link href="/app/settings">Settings</s-link>
        <s-link href="/about" target="_top">
          About
        </s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
