import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

interface DataRequestPayload {
  customer?: { id?: number | string };
  orders_requested?: number[];
}

// Mandatory GDPR/CCPA compliance webhook — Shopify requires every public
// app to handle this, even if you hold no customer PII.
//
// LeakAudit stores exactly two things: Shopify session tokens (Session
// table) and a per-shop settings row (ShopSettings table, keyed by shop
// domain). Neither is linked to an individual customer, so there is no
// customer data to export here. We still log receipt for an audit trail.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const typedPayload = payload as DataRequestPayload;

  console.log(`Received ${topic} webhook for ${shop}`, {
    customerId: typedPayload.customer?.id,
    ordersRequested: typedPayload.orders_requested,
  });

  // No customer-linked data stored by this app — nothing to export.
  return new Response();
};
