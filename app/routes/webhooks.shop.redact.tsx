import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

// Mandatory compliance webhook — fires ~48h after uninstall. We must
// delete ALL data we hold for this shop, not just Session/ShopSettings.
// (webhooks.app.uninstalled.tsx already clears the Session table on
// uninstall; this is the authoritative, delayed "actually erase
// everything" signal, so we clean up every table keyed by shop here,
// idempotently.) This previously left AuditSnapshot (scan history) and
// Feedback rows behind indefinitely after a shop uninstalled — a real gap
// against both the "scan history is deleted" claim in privacy.tsx and
// Shopify's actual App Store review requirement that this webhook erase
// everything held for the shop.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  await Promise.all([
    db.session.deleteMany({ where: { shop } }),
    db.shopSettings.deleteMany({ where: { shop } }),
    db.auditSnapshot.deleteMany({ where: { shop } }),
    db.feedback.deleteMany({ where: { shop } }),
  ]);

  return new Response();
};
