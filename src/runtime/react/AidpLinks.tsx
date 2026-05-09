// Site-wide HTML link tags per AIDP §8.5.
//
// Usage in app/layout.tsx:
//   import { AidpLinks } from '@speakspec/next/react'
//   export default function RootLayout({ children }) {
//     return (
//       <html>
//         <head>
//           <AidpLinks />
//         </head>
//         <body>{children}</body>
//       </html>
//     )
//   }
//
// React server component — renders to the head as plain <link> tags.
// Quietly no-ops when siteOrigin / endpoint are unset (the route
// handlers will surface 503 if anything tries to hit them).

import { readConfig } from '../config'

export function AidpLinks() {
  const config = readConfig()
  if (!config.siteOrigin || !config.endpoint) return null

  const stripTrailingSlash = (s: string) => (s.endsWith('/') ? s.slice(0, -1) : s)
  const entityHref = `${stripTrailingSlash(config.siteOrigin)}/.well-known/aidp.json`
  const keysHref = `${stripTrailingSlash(config.endpoint)}/.well-known/aidp-keys`

  return (
    <>
      <link rel="aidp" href={entityHref} />
      <link rel="aidp-keys" href={keysHref} />
    </>
  )
}

/**
 * Per-page binding — call from a Server Component / page to inject
 * the per-content link tag AND register (path → content_id) for the
 * bot-detect middleware to enrich impression records.
 *
 *   export default async function ArticlePage({ params }) {
 *     const article = await loadArticle(params.id)
 *     return (
 *       <>
 *         <AidpContent contentId={article.id} pathname={`/articles/${article.id}`} />
 *         <article>{article.body}</article>
 *       </>
 *     )
 *   }
 */
export interface AidpContentProps {
  contentId: string
  /** Path the AI crawler will hit. Required so the middleware can
   *  enrich subsequent impressions with content_id. */
  pathname: string
}

export function AidpContent({ contentId, pathname }: AidpContentProps) {
  const config = readConfig()
  if (!config.siteOrigin || !contentId) return null

  // Side-effect register at render time (server-only — Next will
  // skip the import on client). The registry is in-process so the
  // next AI fetch on this path finds the mapping.
  if (typeof window === 'undefined' && pathname) {
    // Dynamic import to avoid pulling server-only module into client
    // bundle. fire-and-forget; failure is harmless.
    import('../server/utils/content-registry').then(m => m.registerContent(pathname, contentId))
  }

  const stripTrailingSlash = (s: string) => (s.endsWith('/') ? s.slice(0, -1) : s)
  const href = `${stripTrailingSlash(config.siteOrigin)}/.well-known/aidp/content/${encodeURIComponent(contentId)}.json`
  return <link rel="aidp-content" href={href} />
}
