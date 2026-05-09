// Next.js middleware factory for AI crawler detection.
//
// Usage:
//   // middleware.ts (root of project)
//   import { aidpBotMiddleware } from '@speakspec/next/middleware'
//   export default aidpBotMiddleware()
//   export const config = { matcher: '/((?!_next|api/_aidp).*)' }
//
// Behavior mirrors @speakspec/nuxt's middleware:
//   - Off when SPEAKSPEC_BOT_TRACKING !== 'true'
//   - Skips paths under SPEAKSPEC_BOT_EXCLUDE_PATHS
//   - On AI crawler match: emits a structured JSON impression
//     - `botTracking.upload.enabled` → batched POST to SpeakSpec
//     - otherwise → console.log fallback
//   - Never blocks the request — it's a pass-through observer

import { NextResponse, type NextRequest } from 'next/server'
import { detectAICrawler, isExcludedPath } from '../server/utils/bot-detect'
import { lookupContentId } from '../server/utils/content-registry'
import { configureQueue, enqueueImpression, type ImpressionRecord } from '../server/utils/impression-queue'
import { readConfig } from '../config'

let queueConfigured = false

export function aidpBotMiddleware() {
  return function middleware(request: NextRequest): NextResponse {
    const config = readConfig()
    if (!config.botTracking.enabled) {
      return NextResponse.next()
    }

    const url = new URL(request.url)
    const path = url.pathname

    if (isExcludedPath(path, config.botTracking.excludePaths)) {
      return NextResponse.next()
    }

    const ua = request.headers.get('user-agent') ?? ''
    const matched = detectAICrawler(ua)
    if (!matched) {
      return NextResponse.next()
    }

    const impression: ImpressionRecord = {
      msg: 'aidp.crawler_impression',
      crawler: matched.label,
      crawler_source: matched.source,
      path,
      user_agent: ua.slice(0, 256),
      ts: new Date().toISOString(),
    }
    if (config.entityId) impression.entity_id = config.entityId
    const cid = lookupContentId(path)
    if (cid) impression.content_id = cid
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      ?? request.headers.get('x-real-ip')
      ?? undefined
    if (ip) impression.client_ip = ip

    const upload = config.botTracking.upload
    if (upload.enabled && config.entityId && config.apiKey) {
      if (!queueConfigured) {
        configureQueue({
          endpoint: config.endpoint,
          apiKey: config.apiKey,
          batchSize: upload.batchSize,
          flushIntervalMs: upload.flushIntervalMs,
          maxQueueBytes: upload.maxQueueBytes,
          onError: upload.onError,
        })
        queueConfigured = true
      }
      enqueueImpression(impression)
    }
    else {
      console.log(JSON.stringify(impression))
    }

    return NextResponse.next()
  }
}
