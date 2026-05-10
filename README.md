# @speakspec/next

> AIDP 0.3 publishing channel for Next.js 15 (App Router).

A Next.js package that turns your site into a first-class [AIDP](https://github.com/speakspec/aidp) source: publishes the entity directive at `/.well-known/aidp.json`, exposes signed content endpoints + a paginated content directory, injects `<link rel="aidp">` head tags, receives cache-invalidation webhooks from SpeakSpec, and observes AI-crawler traffic for upload to your dashboard.

Feature-equivalent to [`@speakspec/nuxt`](https://docs.speakspec.com/developer/sdk-nuxt).

## Install

```bash
pnpm add @speakspec/next
```

## Configure (env vars)

```env
# .env.local
SPEAKSPEC_ENTITY_ID=your-entity-slug
SPEAKSPEC_API_KEY=aidp_xxxxxxxxxxx
SPEAKSPEC_WEBHOOK_SECRET=...
NEXT_PUBLIC_SPEAKSPEC_SITE_ORIGIN=https://yoursite.com
SPEAKSPEC_BOT_TRACKING=true
SPEAKSPEC_BOT_UPLOAD=true
```

## Wire the well-known routes

Create one route file per AIDP endpoint and re-export the SDK's
factory:

```ts
// app/.well-known/aidp.json/route.ts
import { aidpEntityRoute } from '@speakspec/next'
export const GET = aidpEntityRoute()
```

```ts
// app/.well-known/aidp/content/[id]/route.ts
import { aidpContentRoute } from '@speakspec/next'
export const GET = aidpContentRoute()
```

```ts
// app/.well-known/aidp/content/route.ts
import { aidpDirectoryRoute } from '@speakspec/next'
export const GET = aidpDirectoryRoute()
```

```ts
// app/api/_aidp/invalidate/route.ts
import { aidpWebhookRoute } from '@speakspec/next'
export const POST = aidpWebhookRoute()
```

## Wire the bot-detection middleware

```ts
// middleware.ts (project root)
import { aidpBotMiddleware } from '@speakspec/next/middleware'
export default aidpBotMiddleware()

export const config = {
  // Apply to all routes EXCEPT Next internals + the webhook endpoint
  matcher: '/((?!_next/static|_next/image|api/_aidp/invalidate|favicon.ico).*)',
}
```

## Inject HTML link tags

```tsx
// app/layout.tsx
import { AidpLinks } from '@speakspec/next/react'

export default function RootLayout({ children }) {
  return (
    <html>
      <head>
        <AidpLinks />
      </head>
      <body>{children}</body>
    </html>
  )
}
```

For per-page binding on article / product / policy pages:

```tsx
// app/articles/[id]/page.tsx
import { AidpContent } from '@speakspec/next/react'

export default async function ArticlePage({ params }) {
  const article = await loadArticle((await params).id)
  return (
    <>
      <AidpContent contentId={article.id} pathname={`/articles/${article.id}`} />
      <article>{article.body}</article>
    </>
  )
}
```

Calling `<AidpContent />` registers the `(path → content_id)`
mapping with the SDK so subsequent AI crawler hits on that path get
enriched with `content_id` in the impression.

## Cache layer

The SDK ships an in-memory cache by default — fine for single-instance
deployments and warm Vercel functions. Multi-instance (or wanting
durability across cold starts) customers can plug in a Redis-backed
or fs-backed store at boot:

```ts
// app/instrumentation.ts
import { setCacheStore } from '@speakspec/next'
import { redisStore } from './my-cache'

export function register() {
  setCacheStore(redisStore)
}
```

Any object satisfying:

```ts
interface FullStore {
  getItem<T>(key: string): Promise<T | null>
  setItem(key: string, value: unknown): Promise<void>
  removeItem(key: string): Promise<void>
  getKeys(base: string): Promise<string[]>  // prefix match
}
```

works.

## Cache tuning

The SDK serves three well-known routes with `Cache-Control` headers
tuned for fast revocation propagation. If you have Cloudflare /
CloudFront in front of your site, those headers are what the CDN
respects — so they directly bound how long it takes a revoked fact
to disappear from AI agent answers.

There are two TTLs to think about:

| Layer | What it does | Default | Affects |
|---|---|---|---|
| **SDK internal** | how long the SDK process reuses a fetched bundle before re-fetching from SpeakSpec | 300s | origin load on SpeakSpec |
| **`Cache-Control: max-age`** | how long downstream caches (CDN + AI agents) reuse the response | 60s (entity/directory), 300s (content) | revocation propagation, CDN cost |

**Why entity = 60s but content = 300s by default?** The entity directive (`/.well-known/aidp.json`) is the revocation pivot — when a customer revokes a fact, this is the document AI agents re-fetch first to learn what's still valid. Short `max-age` keeps revocation fast. Per-content envelopes (`/.well-known/aidp/content/[id].json`) are content-addressed: each `updated_at` produces a new signed bundle, so longer caching is safe.

**Setting `max-age=0`** disables CDN caching for that route but does NOT disable `stale-while-revalidate` — the CDN still serves stale within the SWR window while it revalidates. To fully disable caching, set both `*_MAX_AGE=0` and `*_SWR=0`.

The SDK internal TTL is mostly the safety net for missed webhooks —
when an entity is revoked, SpeakSpec sends a webhook that clears the
SDK cache instantly. Downstream `max-age` is the real ceiling on how
quickly AI agents see the revocation.

All values are configurable via env vars (seconds):

```env
# SDK internal cache (default 300)
SPEAKSPEC_CACHE_TTL_SEC=300

# /.well-known/aidp.json (default 60 / 300)
SPEAKSPEC_ENTITY_MAX_AGE=60
SPEAKSPEC_ENTITY_SWR=300

# /.well-known/aidp/content/[id] (default 300 / 600)
SPEAKSPEC_CONTENT_MAX_AGE=300
SPEAKSPEC_CONTENT_SWR=600

# /.well-known/aidp/content (default 60 / 300)
SPEAKSPEC_DIRECTORY_MAX_AGE=60
SPEAKSPEC_DIRECTORY_SWR=300
```

**Trade-off**: longer `max-age` means lower origin/CDN bill but
slower revocation. Worst-case revocation propagation is bounded by
`max-age + stale-while-revalidate`. If you want sub-minute revocation
across Cloudflare, also wire SpeakSpec's webhook to a Cloudflare
purge — out of SDK scope.

## Caveats vs `@speakspec/nuxt`

- **Edge runtime**: the bot-detect middleware is Edge-safe (no
  Node-specific APIs); the impression upload queue uses `fetch` and
  `console.log` only — also Edge-safe. However, the webhook receiver
  uses `node:crypto` HMAC verification and **must** run in the Node
  runtime. Pin it explicitly in `app/api/_aidp/invalidate/route.ts`:
  ```ts
  import { aidpWebhookRoute } from '@speakspec/next'
  export const runtime = 'nodejs'
  export const POST = aidpWebhookRoute()
  ```
- **Multi-instance**: in-memory cache + impression queue are
  per-process. Vercel cold starts may drop in-flight impressions.
  Acceptable per fire-and-forget design; see `setCacheStore` for
  shared persistence.
- **First-hit content_id**: `<AidpContent />` registers on render, so
  the very first AI crawler hit on a path lands with `content_id=null`.
  Subsequent hits are enriched.

## Spec & references

- [AIDP 0.3 §4.8 Cryptographic Proof](https://docs.speakspec.com/spec/transport#cryptographic-proof)
- [AIDP 0.3 §8.5–8.13 Transport](https://docs.speakspec.com/spec/transport)
- [Authenticated API](https://docs.speakspec.com/api/authenticated)

## License

MIT
