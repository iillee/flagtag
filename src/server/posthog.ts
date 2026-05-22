/**
 * posthog.ts — PostHog analytics via HTTP API (no Node.js dependencies).
 * 
 * NOTE: The deployed auth server environment may not be able to reach external
 * hosts. All fetch calls are fire-and-forget with silent error handling to
 * prevent ETIMEDOUT errors from destabilizing the server.
 */

import { EnvVar } from '@dcl/sdk/server'

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

export function identify(distinctId: string, personProperties: Record<string, any>): void {
  if (!apiKey) return

  const body = JSON.stringify({
    api_key: apiKey,
    event: '$identify',
    distinct_id: distinctId,
    properties: { $set: personProperties },
    timestamp: new Date().toISOString()
  })

  fetch(`${host}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  }).then(() => {}, () => {})
}

export function capture(distinctId: string, event: string, properties?: Record<string, any>): void {
  if (!apiKey) return

  const body = JSON.stringify({
    api_key: apiKey,
    event,
    distinct_id: distinctId,
    properties: properties ?? {},
    timestamp: new Date().toISOString()
  })

  fetch(`${host}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  }).then(() => {}, () => {})
}
