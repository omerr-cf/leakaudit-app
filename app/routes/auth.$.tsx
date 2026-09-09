
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

// This route (a splat, so it matches /auth and every subpath) only exists
// to run the OAuth/session-token handshake via authenticate.admin(). Once
// that resolves, there's nothing to render -- but returning `null` meant
// the document response body was the literal text "null", which is what
// Chrome's own JSON viewer was showing embedded merchants ("Pretty-print
// [] null") instead of ever reaching the dashboard. Redirect into the
// real embedded app instead, preserving shop/host/embedded the same way
// the root route (_index/route.tsx) already does.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  throw redirect(`/app?${url.searchParams.toString()}`);
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
