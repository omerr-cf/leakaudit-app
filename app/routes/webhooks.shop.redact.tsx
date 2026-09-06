import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

// Mandatory compliance webhook — fires ~48h after uninstall. We must
// delete ALL data we hold for this shop. (webhooks.app.uninstalled.tsx
// already clears the Session table on uninstall; this is the
// authoritative, delayed "actually erase everything" signal, so we
// clean up both tables again here to be safe/idempotent.)
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  await Promise.all([
    db.session.deleteMany({ where: { shop } }),
    db.shopSettings.deleteMany({ where: { shop } }),
  ]);

  return new Response();
};
