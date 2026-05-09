// Runtime configuration for @speakspec/next.
//
// Next.js doesn't have a "module options" system like Nuxt's
// nuxt.config.ts, so we read configuration from environment
// variables at runtime. Customers can override any individual value
// by passing options into the route-handler factories.

export interface SpeakspecConfig {
  entityId: string
  apiKey: string
  webhookSecret: string
  endpoint: string
  siteOrigin: string
  botTracking: {
    enabled: boolean
    excludePaths: string[]
    upload: {
      enabled: boolean
      batchSize: number
      flushIntervalMs: number
      maxQueueBytes: number
      onError: 'fallback-stdout' | 'silent'
    }
  }
}

const DEFAULT_EXCLUDE_PATHS = ['/_next/', '/api/_aidp/']

export function readConfig(): SpeakspecConfig {
  const env = process.env
  return {
    entityId: env.SPEAKSPEC_ENTITY_ID ?? '',
    apiKey: env.SPEAKSPEC_API_KEY ?? '',
    webhookSecret: env.SPEAKSPEC_WEBHOOK_SECRET ?? '',
    endpoint: env.SPEAKSPEC_ENDPOINT ?? 'https://api.speakspec.com',
    siteOrigin: env.NEXT_PUBLIC_SPEAKSPEC_SITE_ORIGIN ?? env.NEXT_PUBLIC_SITE_URL ?? '',
    botTracking: {
      enabled: env.SPEAKSPEC_BOT_TRACKING === 'true',
      excludePaths: env.SPEAKSPEC_BOT_EXCLUDE_PATHS
        ? env.SPEAKSPEC_BOT_EXCLUDE_PATHS.split(',').map(s => s.trim()).filter(Boolean)
        : DEFAULT_EXCLUDE_PATHS,
      upload: {
        enabled: env.SPEAKSPEC_BOT_UPLOAD === 'true',
        batchSize: Number(env.SPEAKSPEC_BOT_BATCH_SIZE ?? 50),
        flushIntervalMs: Number(env.SPEAKSPEC_BOT_FLUSH_MS ?? 60_000),
        maxQueueBytes: Number(env.SPEAKSPEC_BOT_QUEUE_BYTES ?? 2 * 1024 * 1024),
        onError: (env.SPEAKSPEC_BOT_ON_ERROR === 'silent' ? 'silent' : 'fallback-stdout'),
      },
    },
  }
}

/** Belt-and-braces slug validation; warn (not throw) so callers can
 *  proceed against the upstream and learn the real error. */
export function validateEntityId(entityId: string): void {
  if (entityId && !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(entityId)) {
    console.warn(
      `[@speakspec/next] entityId %o does not match SpeakSpec's slug rule `
      + `(lowercase alphanumerics and hyphens, no leading/trailing hyphen). `
      + `Verify against your SpeakSpec dashboard — pasting the URN form `
      + `(urn:aidp:entity:foo) instead of the bare slug is a common mistake.`,
      entityId,
    )
  }
}
