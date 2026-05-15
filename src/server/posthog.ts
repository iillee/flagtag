/**
 * posthog.ts — PostHog analytics via HTTP API (no Node.js dependencies).
 */

import { EnvVar } from '@dcl/sdk/server'
import { signedFetch } from '~system/SignedFetch'

let apiKey: string | null = null
let host: string = 'https://us.i.posthog.com'

export async function initPostHog(): Promise<void> {
  try {
    const token = (await EnvVar.get('POSTHOG_PROJECT_TOKEN')) || ''
    const h = (await EnvVar.get('POSTHOG_HOST')) || ''
    if (!token) {
      console.log('[PostHog] No POSTHOG_PROJECT_TOKEN set — analytics disabled')
      return
    }
    apiKey = token
    if (h) host = h
    console.log('[PostHog] ✅ Initialized')
  } catch (err) {
    console.error('[PostHog] Failed to initialize:', err)
  }
}

export function capture(distinctId: string, event: string, properties?: Record<string, any>): void {
  if (!apiKey) return
  console.log('[PostHog] capturing event', event, properties)

  const body = JSON.stringify({
    api_key: apiKey,
    event,
    distinct_id: distinctId,
    properties: properties ?? {},
    timestamp: new Date().toISOString()
  })

  signedFetch({
    url: `${host}/capture/`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    }
  }).catch((err) => {
    console.error(`[PostHog] capture failed for event "${event}"`, err)
  })
}
