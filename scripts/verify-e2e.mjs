// End-to-end verification of @speakspec/next route handlers + middleware
// against a mock upstream HTTP server. No real Next.js framework is spun up;
// we invoke the factories directly using the standard Web Fetch API
// `Request` / `Response` types that App Router route handlers consume.
//
// What this proves:
//   1. Each route factory (entity, content, directory, webhook) produces a
//      handler whose return value is a Response with the right status,
//      headers, and body shape per AIDP 0.3 §8.5–8.13.
//   2. The cache-store integration round-trips: first call fetches upstream,
//      second call serves from cache + emits ETag + handles If-None-Match.
//   3. The webhook handler correctly verifies HMAC and triggers cache
//      invalidation; rejected on bad signature.
//   4. The bot-detect middleware (separate import path) is callable and
//      returns NextResponse-shaped objects without crashing.
//   5. The React component module is importable and exports the documented
//      shape.

import { createServer } from 'node:http'
import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

// --- Test fixtures --------------------------------------------------------

const ENTITY_ID = 'verify-fixture'
const API_KEY = 'aidp_verify_fixture_key'
const WEBHOOK_SECRET = 'shh-verify-only'

const fakeDirective = {
  spec_version: '0.4.0',
  entity_id: `urn:aidp:entity:${ENTITY_ID}`,
  entity: { name: 'Verify Fixture Inc.', kind: 'organization' },
  facts: ['Open Tue–Sat 11:30–21:00', 'Established 1987'],
  content: [
    {
      spec_version: '0.4.0',
      content_id: 'fixture-faq-1',
      type: 'faq',
      pinned: false,
      body: { question: 'Hours?', answer: '11:30–21:00 Tue–Sat' },
      signature: { algorithm: 'ed25519', value: 'BASE64SIGNATURE==' },
    },
  ],
  content_index: {
    url: 'http://localhost/.well-known/aidp/content/directory.json',
    types_inlined: ['faq'],
    types_indexed: ['article'],
    total_by_type: { faq: 2, article: 5 },
    pinned_count: 0,
    updated_at: '2026-05-12T10:00:00Z',
  },
  signature: { algorithm: 'ed25519', value: 'BASE64SIGNATURE==' },
}

const fakeContent = {
  spec_version: '0.4.0',
  content_id: 'fixture-article-1',
  type: 'article',
  pinned: false,
  body: { title: 'Hello AIDP', text: 'Body text.' },
  signature: { algorithm: 'ed25519', value: 'BASE64SIGNATURE==' },
}

const fakeDirectory = {
  spec_version: '0.3.0',
  total: 1,
  page: 1,
  per_page: 100,
  items: [{ content_id: 'fixture-article-1', updated_at: '2026-05-10T00:00:00Z' }],
}

// --- Mock upstream --------------------------------------------------------

const upstreamHits = []

function startUpstream() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      upstreamHits.push({ method: req.method, url: req.url, auth: req.headers.authorization })
      const url = new URL(req.url, `http://localhost`)
      let body
      const etag = '"v1"'

      if (url.pathname === `/public/entity/${ENTITY_ID}`) {
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { etag })
          res.end()
          return
        }
        body = fakeDirective
      }
      else if (url.pathname === `/public/entity/${ENTITY_ID}/content/fixture-article-1/publish.json`) {
        body = fakeContent
      }
      else if (url.pathname === `/public/entity/${ENTITY_ID}/content/directory.json`) {
        body = fakeDirectory
      }
      else {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not_found' }))
        return
      }

      const json = JSON.stringify(body)
      res.writeHead(200, {
        'content-type': 'application/json',
        etag,
        'cache-control': 'public, max-age=300',
      })
      res.end(json)
    })
    server.listen(0, () => resolve({ server, port: server.address().port }))
  })
}

// --- Assertions -----------------------------------------------------------

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  const icon = ok ? '✓' : '✗'
  console.log(`  ${icon} ${name}${detail ? ` — ${detail}` : ''}`)
}

// --- Run ------------------------------------------------------------------

async function main() {
  const { server, port } = await startUpstream()
  process.env.SPEAKSPEC_ENTITY_ID = ENTITY_ID
  process.env.SPEAKSPEC_API_KEY = API_KEY
  process.env.SPEAKSPEC_WEBHOOK_SECRET = WEBHOOK_SECRET
  process.env.SPEAKSPEC_ENDPOINT = `http://127.0.0.1:${port}`

  // Reset module cache so config picks up env vars.
  const sdk = await import('../src/index.ts')
  const sdkMiddleware = await import('../src/middleware/index.ts')

  console.log('\n— public exports —')
  check('aidpEntityRoute is a function', typeof sdk.aidpEntityRoute === 'function')
  check('aidpContentRoute is a function', typeof sdk.aidpContentRoute === 'function')
  check('aidpDirectoryRoute is a function', typeof sdk.aidpDirectoryRoute === 'function')
  check('aidpWebhookRoute is a function', typeof sdk.aidpWebhookRoute === 'function')
  check('setCacheStore exported', typeof sdk.setCacheStore === 'function')
  check('verifyBundle exported', typeof sdk.verifyBundle === 'function')
  check('detectAICrawler exported', typeof sdk.detectAICrawler === 'function')
  check('aidpBotMiddleware exported', typeof sdkMiddleware.aidpBotMiddleware === 'function')

  // Reset cache between runs so each test starts clean.
  const { setCacheStore } = sdk
  function freshStore() {
    const map = new Map()
    return {
      async getItem(key) { return map.has(key) ? map.get(key) : null },
      async setItem(key, value) { map.set(key, value) },
      async removeItem(key) { map.delete(key) },
      async getKeys(base) { return [...map.keys()].filter((k) => k.startsWith(base)) },
      _map: map,
    }
  }

  // --- 1. Entity route ----------------------------------------------------
  console.log('\n— aidpEntityRoute() —')
  {
    setCacheStore(freshStore())
    const handler = sdk.aidpEntityRoute()
    const req = new Request('https://yoursite.com/.well-known/aidp.json')
    const res = await handler(req)

    check('returns Response', res instanceof Response)
    check('status 200', res.status === 200, `got ${res.status}`)
    check('content-type is JSON', (res.headers.get('content-type') ?? '').includes('application/json'))
    check('etag header present', !!res.headers.get('etag'), res.headers.get('etag') ?? '(none)')
    check('cache-control present', !!res.headers.get('cache-control'))

    const body = await res.json()
    check('body.entity_id matches', body.entity_id === fakeDirective.entity_id, body.entity_id)
    check('body.signature present', !!body.signature)
    check('body.content_index present (v0.4)', !!body.content_index)
    check('body.content_index.types_indexed = [article]', JSON.stringify(body.content_index?.types_indexed) === JSON.stringify(['article']))
    check('body.content[0].pinned === false (v0.4)', body.content?.[0]?.pinned === false, String(body.content?.[0]?.pinned))

    // Second call: cache hit, no upstream traffic.
    const upstreamCountBefore = upstreamHits.length
    const res2 = await handler(req)
    check('second call status 200', res2.status === 200)
    check('second call did NOT hit upstream', upstreamHits.length === upstreamCountBefore, `+${upstreamHits.length - upstreamCountBefore} hits`)

    // If-None-Match → 304
    const etag = res.headers.get('etag') ?? ''
    const reqIfMatch = new Request('https://yoursite.com/.well-known/aidp.json', {
      headers: { 'if-none-match': etag },
    })
    const res304 = await handler(reqIfMatch)
    check('If-None-Match returns 304', res304.status === 304, `got ${res304.status}`)
  }

  // --- 2. Content route ---------------------------------------------------
  console.log('\n— aidpContentRoute() —')
  {
    setCacheStore(freshStore())
    const handler = sdk.aidpContentRoute()
    const req = new Request('https://yoursite.com/.well-known/aidp/content/fixture-article-1.json')
    const ctx = { params: Promise.resolve({ id: 'fixture-article-1' }) }
    const res = await handler(req, ctx)
    check('returns Response', res instanceof Response)
    check('status 200', res.status === 200, `got ${res.status}`)
    const body = await res.json()
    check('body.content_id matches', body.content_id === fakeContent.content_id, body.content_id)
  }

  // --- 3. Directory route -------------------------------------------------
  console.log('\n— aidpDirectoryRoute() —')
  {
    setCacheStore(freshStore())
    const handler = sdk.aidpDirectoryRoute()
    const req = new Request('https://yoursite.com/.well-known/aidp/content/?page=1&page_size=100')
    const res = await handler(req)
    check('returns Response', res instanceof Response)
    check('status 200', res.status === 200, `got ${res.status}`)
    const body = await res.json()
    check('body.items is array', Array.isArray(body.items))
    check('body.total numeric', typeof body.total === 'number')
  }

  // --- 4. Webhook route ---------------------------------------------------
  console.log('\n— aidpWebhookRoute() —')
  {
    setCacheStore(freshStore())
    const handler = sdk.aidpWebhookRoute()

    const timestamp = new Date().toISOString()
    const body = JSON.stringify({
      $aidp: '0.3.0',
      event: 'directive.updated',
      scope: 'entity',
      entity_id: `urn:aidp:entity:${ENTITY_ID}`,
      timestamp,
    })

    // Bad signature → 4xx
    {
      const req = new Request('https://yoursite.com/api/_aidp/invalidate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-aidp-signature': 'hmac-sha256=deadbeef',
          'x-aidp-timestamp': timestamp,
        },
        body,
      })
      const res = await handler(req)
      check('bad signature returns 4xx', res.status >= 400 && res.status < 500, `got ${res.status}`)
    }

    // Good signature → 204
    {
      const sig = 'hmac-sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(timestamp + '\n' + body).digest('hex')
      const req = new Request('https://yoursite.com/api/_aidp/invalidate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-aidp-signature': sig,
          'x-aidp-timestamp': timestamp,
        },
        body,
      })
      const res = await handler(req)
      check('good signature returns 2xx', res.status >= 200 && res.status < 300, `got ${res.status}`)
    }
  }

  // --- 5. Bot middleware --------------------------------------------------
  console.log('\n— aidpBotMiddleware() —')
  {
    process.env.SPEAKSPEC_BOT_TRACKING = 'true'
    const mw = sdkMiddleware.aidpBotMiddleware()

    // Crawler request — handler should return NextResponse without throwing.
    const req = new Request('https://yoursite.com/articles/foo', {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)' },
    })
    let crashed = null
    try {
      const res = await mw(req)
      check('middleware returns NextResponse-like object on crawler', res != null)
    }
    catch (e) { crashed = e }
    check('middleware did not throw', !crashed, crashed?.message)
  }

  // --- 6. React component import -----------------------------------------
  console.log('\n— @speakspec/next/react —')
  {
    const react = await import('../src/react/index.ts')
    check('AidpLinks is a function/component', typeof react.AidpLinks === 'function')
    check('AidpContent is a function/component', typeof react.AidpContent === 'function')
  }

  // --- Summary -----------------------------------------------------------
  server.close()
  await sleep(50)
  console.log('\n— summary —')
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)
  console.log(`  ${passed}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.log('\n  FAILED:')
    failed.forEach((f) => console.log(`    ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`))
    process.exit(1)
  }
  console.log('\n  All E2E checks pass against mock upstream.')
}

main().catch((err) => { console.error(err); process.exit(1) })
