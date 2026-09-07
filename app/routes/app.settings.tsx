import { useAppBridge } from "@shopify/app-bridge-react";
import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useFetcher, useLoaderData, useNavigation } from "react-router";
import db from "../db.server";
import { runAudit } from "../services/audit.server";
import { sendAuditAlertEmail } from "../services/email.server";
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

  const feedbackEntries = await db.feedback.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return {
    shippingCostPerOrder: settings.shippingCostPerOrder,
    targetMarginPercent: settings.targetMarginPercent,
    notificationEmail: settings.notificationEmail ?? shopEmail,
    feedback: feedbackEntries.map((f) => ({
      id: f.id,
      message: f.message,
      createdAt: f.createdAt.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "send-test-alert") {
    // Uses whatever's already SAVED for this shop, not an unsaved form
    // field — save settings first, then send the test.
    const settings = await db.shopSettings.upsert({
      where: { shop: session.shop },
      update: {},
      create: { shop: session.shop },
    });
    const report = await runAudit(admin, session.shop, {
      shippingCostPerOrder: settings.shippingCostPerOrder,
      targetMarginPercent: settings.targetMarginPercent,
    });
    const result = await sendAuditAlertEmail(
      settings.notificationEmail ?? "",
      report,
    );
    return { testAlert: result };
  }

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
  const testAlertFetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const isSendingTest = testAlertFetcher.state !== "idle";

  useEffect(() => {
    const result = testAlertFetcher.data?.testAlert;
    if (!result || isSendingTest) return;
    shopify.toast.show(
      result.sent
        ? "Test alert email sent — check your inbox."
        : `Couldn't send test alert: ${result.reason}`,
      { isError: !result.sent },
    );
    // Only fire when a fresh result actually arrives, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testAlertFetcher.data]);

  const handleSendTestAlert = () => {
    testAlertFetcher.submit({ intent: "send-test-alert" }, { method: "post" });
  };

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

      <s-section heading="Weekly alert email">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Send yourself a real test email right now, using whatever
            notification email is currently saved above (save it first if you
            just changed it).
          </s-paragraph>
          <s-button
            onClick={handleSendTestAlert}
            {...(isSendingTest ? { loading: true } : {})}
          >
            Send Test Alert Now
          </s-button>
          <s-paragraph color="subdued">
            This sends one email immediately — it doesn't yet run automatically
            on a weekly schedule (that needs the app deployed somewhere that can
            run a schedule, not just your laptop).
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Feedback You've Sent">
        {data.feedback.length === 0 ? (
          <s-paragraph color="subdued">
            Nothing yet — anything you type into the "Send Us Feedback" box on
            the Home tab will show up here, permanently saved, whether or not
            email notifications are set up.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {data.feedback.map((entry) => (
              <s-box
                key={entry.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small">
                  <s-paragraph>{entry.message}</s-paragraph>
                  <s-paragraph color="subdued">
                    {new Date(entry.createdAt).toLocaleString()}
                  </s-paragraph>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}
