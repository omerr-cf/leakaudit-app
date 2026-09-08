import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,

  // React Router 7's built-in action CSRF check rejects a POST whenever the
  // browser's `Origin` header doesn't match the request URL's own origin —
  // unless the origin is explicitly allow-listed here.
  //
  // In dev, the app is actually served to the browser through Shopify CLI's
  // Cloudflare Quick Tunnel (a random "*.trycloudflare.com" hostname that's
  // regenerated every time `npm run dev` restarts) — NOT admin.shopify.com.
  // The iframe's document (and therefore every fetcher.submit() call made
  // from inside it) has that tunnel URL as its origin, so THAT'S the value
  // this check actually compares — which is why "admin.shopify.com" /
  // "*.myshopify.com" alone never fixed it. Wildcarding the tunnel host
  // covers every restart without hand-editing this file each time.
  //
  // In production (deployed to your own domain, no tunnel) the real embed
  // origin is admin.shopify.com / the shop's own myshopify.com admin, so
  // both stay listed for that environment.
  //
  // "leakaudit-app.fly.dev" is listed for a DIFFERENT reason: Fly.io
  // terminates TLS at its own edge and forwards every request to the app
  // as plain HTTP internally. `@react-router/serve` never calls Express's
  // `app.set("trust proxy", ...)`, so `req.protocol` always reports "http"
  // regardless of what the browser actually used — meaning every
  // server-built `request.url` here is `http://leakaudit-app.fly.dev/...`
  // even though the real request was https. That makes this check see a
  // same-site request (the standalone, non-embedded `/auth/login` page,
  // submitted to itself) as if it were cross-origin, purely over a
  // scheme mismatch (http vs https), and reject it — confirmed via Fly
  // logs: "The `request.url` origin does not match `origin` header from a
  // forwarded action request." on POST /auth/login. Listing the app's own
  // production host here is the fix react-router itself provides for
  // exactly this "deployed behind a TLS-terminating proxy" situation,
  // without needing a custom Express server just to flip trust-proxy on.
  // Update this if the app ever moves to a custom domain.
  //
  // IMPORTANT: this option lives on the React Router app config
  // (react-router.config.ts), NOT on the reactRouter() Vite plugin in
  // vite.config.ts — passing it there is silently ignored (confirmed by
  // reading node_modules/@react-router/dev/dist/config.d.ts and
  // node_modules/react-router/dist/development/chunk-HT4INDD5.mjs).
  allowedActionOrigins: [
    "admin.shopify.com",
    "*.myshopify.com",
    "*.trycloudflare.com",
    "leakaudit-app.fly.dev",
  ],
} satisfies Config;
