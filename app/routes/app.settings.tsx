import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

interface ShopEmailResponse {
  shop: { email: string };
}

const SHOP_EMAIL_QUERY = `#graphql
  query ShopEmail { shop { email } }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const settings = await db.shopSettings.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop },
  });

  let shopEmail = "";
  if (!settings.notificationEmail) {
    const res = await admin.graphql(SHOP_EMAIL_QUERY);
    const data = (await res.json()) as { data: ShopEmailResponse };
    shopEmail = data.data?.shop?.email ?? "";
  }

  return {
    shippingCostPerOrder: settings.shippingCostPerOrder,
    targetMarginPercent: settings.targetMarginPercent,
    notificationEmail: settings.notificationEmail ?? shopEmail,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  const shippingCostPerOrder = clampNumber(
    form.get("shippingCostPerOrder"),
    0,
    1000,
    5.0,
  );
  const targetMarginPercent = clampNumber(
    form.get("targetMarginPercent"),
    0,
    100,
    20,
  );
  const notificationEmail =
    String(form.get("notificationEmail") ?? "").trim() || null;

  await db.shopSettings.upsert({
    where: { shop: session.shop },
    update: { shippingCostPerOrder, targetMarginPercent, notificationEmail },
    create: {
      shop: session.shop,
      shippingCostPerOrder,
      targetMarginPercent,
      notificationEmail,
    },
  });

  return {
    saved: true,
    shippingCostPerOrder,
    targetMarginPercent,
    notificationEmail,
  };
};

function clampNumber(
  value: FormDataEntryValue | null,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = parseFloat(String(value ?? ""));
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSaving = navigation.state !== "idle";

  return (
    <s-page heading="LeakAudit Settings">
      <s-section heading="Audit assumptions">
        <Form method="post">
          <s-stack direction="block" gap="base">
            <s-number-field
              label="Average shipping cost per order"
              name="shippingCostPerOrder"
              step={0.01}
              defaultValue={String(data.shippingCostPerOrder)}
              details="Used to estimate net margin on the Negative-Margin SKUs check. In your store's own currency, not USD."
            />
            <s-number-field
              label="Target minimum profit margin (%)"
              name="targetMarginPercent"
              step={1}
              defaultValue={String(data.targetMarginPercent)}
              details="A SKU is flagged as leaking when its estimated net margin falls below this percentage."
            />
            <s-email-field
              label="Notification email for weekly alerts"
              name="notificationEmail"
              defaultValue={data.notificationEmail}
              details="Defaults to your store's account email."
            />
            <s-button
              variant="primary"
              type="submit"
              {...(isSaving ? { loading: true } : {})}
            >
              Save Settings
            </s-button>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}
