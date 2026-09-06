import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

interface CustomerRedactPayload {
  customer?: { id?: number | string };
}

// Mandatory GDPR/CCPA compliance webhook. Same reasoning as
// webhooks.customers.data_request.tsx: LeakAudit doesn't store any data
// keyed to an individual customer, so there is nothing to redact here.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const typedPayload = payload as CustomerRedactPayload;

  console.log(`Received ${topic} webhook for ${shop}`, {
    customerId: typedPayload.customer?.id,
  });

  return new Response();
};
