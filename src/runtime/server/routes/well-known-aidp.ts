// Factory returning a Next.js App Router GET handler for
//   app/.well-known/aidp.json/route.ts
//
// Usage:
//   // app/.well-known/aidp.json/route.ts
//   import { aidpEntityRoute } from '@speakspec/next'
//   export const GET = aidpEntityRoute()
//
// Workflow on each request (per AIDP transport spec §8.5–8.13):
//   1. Read cached payload + ETag from the cache store.
//   2. If fresh, respond with cached + ETag + Cache-Control. If
//      inbound If-None-Match matches, short-circuit to 304.
//   3. If stale, fetch upstream with cached ETag as If-None-Match.
//      304 → refresh expiresAt, keep payload. 200 → store new bundle.
//   4. Upstream 4xx → surface 502 with detail (operator action
//      required). Upstream 5xx / network → serve stale if available
//      (stale-while-revalidate) or 502.

import type { NextRequest } from 'next/server'
import { fetchEntityDirective } from '../utils/fetch-directive'
import {
  cacheKey,
  isFresh,
  isUpstream4xx,
  respondWithCache,
  DEFAULT_CACHE_TTL_MS,
  type CachedBundle,
} from '../utils/cache'
import { getCacheStore } from '../cache-store'
import { readConfig } from '../../config'

const FRESH_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300'
const STALE_CACHE_CONTROL = 'public, max-age=10, stale-while-revalidate=60'

export function aidpEntityRoute() {
  return async function GET(request: NextRequest): Promise<Response> {
    const config = readConfig()
    if (!config.entityId) {
      return errorResponse(503, 'AIDP module not configured: missing entityId')
    }

    const inboundIfNoneMatch = request.headers.get('if-none-match') ?? undefined
    const store = getCacheStore()
    const key = cacheKey('entity', config.entityId)
    const cached = await store.getItem<CachedBundle<Record<string, unknown>>>(key)

    if (isFresh(cached)) {
      return respondWithCache(cached!.etag, cached!.payload, FRESH_CACHE_CONTROL, inboundIfNoneMatch)
    }

    const upstreamIfNoneMatch = cached?.etag || undefined

    let result
    try {
      result = await fetchEntityDirective({
        endpoint: config.endpoint,
        entityId: config.entityId,
        apiKey: config.apiKey || undefined,
        ifNoneMatch: upstreamIfNoneMatch,
      })
    }
    catch (err) {
      if (isUpstream4xx(err)) {
        const status = (err as { response?: { status?: number } }).response?.status
        return errorResponse(502, `AIDP upstream rejected the directive fetch (${status})`)
      }
      if (cached) {
        return respondWithCache(cached.etag, cached.payload, STALE_CACHE_CONTROL, inboundIfNoneMatch)
      }
      return errorResponse(502, 'AIDP upstream unreachable and no cached payload available')
    }

    if (result.notModified && cached) {
      const refreshed: CachedBundle<Record<string, unknown>> = {
        payload: cached.payload,
        etag: cached.etag,
        expiresAt: Date.now() + DEFAULT_CACHE_TTL_MS,
      }
      await store.setItem(key, refreshed)
      return respondWithCache(refreshed.etag, refreshed.payload, FRESH_CACHE_CONTROL, inboundIfNoneMatch)
    }

    if (!result.payload) {
      return errorResponse(502, 'AIDP upstream returned empty payload')
    }

    const fresh: CachedBundle<Record<string, unknown>> = {
      payload: result.payload,
      etag: result.etag,
      expiresAt: Date.now() + DEFAULT_CACHE_TTL_MS,
    }
    await store.setItem(key, fresh)
    return respondWithCache(fresh.etag, fresh.payload, FRESH_CACHE_CONTROL, inboundIfNoneMatch)
  }
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { statusCode: status, statusMessage: message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
