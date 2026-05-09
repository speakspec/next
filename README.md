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

## Caveats vs `@speakspec/nuxt`

- **Edge runtime**: middleware runs in Edge by default. The bot-detect
  middleware is Edge-safe (no Node-specific APIs); the impression
  upload queue uses `fetch` and `console.log` only — also Edge-safe.
  However, the webhook receiver uses `node:crypto` HMAC verification
  and **must** run in the Node runtime. Set `export const runtime = 'nodejs'`
  in `app/api/_aidp/invalidate/route.ts`:
  ```ts
  export const runtime = 'nodejs'
  export { POST } from '...'  // not valid; assign instead:
  // const _POST = aidpWebhookRoute()
  // export const POST = _POST
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
