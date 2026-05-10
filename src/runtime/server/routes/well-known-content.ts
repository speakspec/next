// Factory returning a Next.js App Router GET handler for
//   app/.well-known/aidp/content/[id]/route.ts
//
// Usage:
//   // app/.well-known/aidp/content/[id]/route.ts
//   import { aidpContentRoute } from '@speakspec/next'
//   export const GET = aidpContentRoute()
//
// Strips a trailing `.json` from the dynamic param so the canonical
// URL `/.well-known/aidp/content/{id}.json` (per spec §8.7) maps to
// the bare contentId for upstream lookups.

import type { NextRequest } from 'next/server'
import { fetchContentEnvelope } from '../utils/fetch-content'
import {
  cacheKey,
  isFresh,
  isUpstream4xx,
  respondWithCache,
  type CachedBundle,
} from '../utils/cache'
import { getCacheStore } from '../cache-store'
import { readConfig, buildCacheControl } from '../../config'

export function aidpContentRoute() {
  return async function GET(
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ): Promise<Response> {
    const config = readConfig()
    if (!config.entityId) {
      return errorResponse(503, 'AIDP module not configured: missing entityId')
    }
    const FRESH_CACHE_CONTROL = buildCacheControl(config.cache.contentMaxAge, config.cache.contentSwr)
    const STALE_CACHE_CONTROL = buildCacheControl(10, 60)
    const ttlMs = config.cache.ttlSec * 1000

    const { id: rawId } = await context.params
    const contentId = rawId.endsWith('.json') ? rawId.slice(0, -5) : rawId
    if (!contentId) {
      return errorResponse(400, 'content id is required')
    }

    const inboundIfNoneMatch = request.headers.get('if-none-match') ?? undefined
    const store = getCacheStore()
    const key = cacheKey('content', `${config.entityId}:${contentId}`)
    const cached = await store.getItem<CachedBundle<Record<string, unknown>>>(key)

    if (isFresh(cached)) {
      return respondWithCache(cached!.etag, cached!.payload, FRESH_CACHE_CONTROL, inboundIfNoneMatch)
    }

    const upstreamIfNoneMatch = cached?.etag || undefined

    let result
    try {
      result = await fetchContentEnvelope({
        endpoint: config.endpoint,
        entityId: config.entityId,
        contentId,
        apiKey: config.apiKey || undefined,
        ifNoneMatch: upstreamIfNoneMatch,
      })
    }
    catch (err) {
      if (isUpstream4xx(err)) {
        const status = (err as { response?: { status?: number } }).response?.status
        return errorResponse(502, `AIDP upstream rejected the content fetch (${status})`)
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
        expiresAt: Date.now() + ttlMs,
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
      expiresAt: Date.now() + ttlMs,
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
