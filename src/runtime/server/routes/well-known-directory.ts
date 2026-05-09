// Factory returning a Next.js App Router GET handler for
//   app/.well-known/aidp/content/route.ts
//
// Usage:
//   // app/.well-known/aidp/content/route.ts
//   import { aidpDirectoryRoute } from '@speakspec/next'
//   export const GET = aidpDirectoryRoute()
//
// Both /.well-known/aidp/content and /.well-known/aidp/content/ end
// up here under Next's default routing — same handler serves both.

import type { NextRequest } from 'next/server'
import { fetchContentDirectory } from '../utils/fetch-directory'
import { parsePositiveInt } from '../utils/query'
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

const ALLOWED_QUERY = new Set(['page', 'page_size', 'type', 'language', 'updated_since'])

export function aidpDirectoryRoute() {
  return async function GET(request: NextRequest): Promise<Response> {
    const config = readConfig()
    if (!config.entityId) {
      return errorResponse(503, 'AIDP module not configured: missing entityId')
    }

    const url = new URL(request.url)
    for (const k of url.searchParams.keys()) {
      if (!ALLOWED_QUERY.has(k)) {
        return errorResponse(400, `unsupported filter: ${k}`)
      }
    }

    let page: number | undefined
    let pageSize: number | undefined
    try {
      page = parsePositiveInt(url.searchParams.get('page'), 'page')
      pageSize = parsePositiveInt(url.searchParams.get('page_size'), 'page_size')
    }
    catch (err) {
      const httpErr = err as { statusCode?: number, statusMessage?: string }
      return errorResponse(httpErr.statusCode ?? 400, httpErr.statusMessage ?? 'invalid query')
    }

    const contentType = url.searchParams.get('type') ?? undefined
    const language = url.searchParams.get('language') ?? undefined
    const updatedSince = url.searchParams.get('updated_since') ?? undefined

    const fingerprint = JSON.stringify({ page, pageSize, contentType, language, updatedSince })
    const inboundIfNoneMatch = request.headers.get('if-none-match') ?? undefined
    const store = getCacheStore()
    const key = cacheKey('directory', `${config.entityId}:${fingerprint}`)
    const cached = await store.getItem<CachedBundle<Record<string, unknown>>>(key)

    if (isFresh(cached)) {
      return respondWithCache(cached!.etag, cached!.payload, FRESH_CACHE_CONTROL, inboundIfNoneMatch)
    }

    const upstreamIfNoneMatch = cached?.etag || undefined

    let result
    try {
      result = await fetchContentDirectory({
        endpoint: config.endpoint,
        entityId: config.entityId,
        apiKey: config.apiKey || undefined,
        page,
        pageSize,
        contentType,
        language,
        updatedSince,
        ifNoneMatch: upstreamIfNoneMatch,
      })
    }
    catch (err) {
      if (isUpstream4xx(err)) {
        const status = (err as { response?: { status?: number } }).response?.status
        return errorResponse(502, `AIDP upstream rejected the directory fetch (${status})`)
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
