/**
 * Shared sanitizers and rate-limit helpers for Discord webhook posts.
 * Secrets must never live in this file — only EnvVar / gitignored .env.
 * Never hardcode a webhook URL and never "hide" one with encoding/obfuscation.
 */

export const FEEDBACK_MAX_LENGTH = 500
/** Global cap across all players, on top of the per-player cooldown. */
export const GLOBAL_FEEDBACK_LIMIT = 8
export const GLOBAL_FEEDBACK_WINDOW_MS = 60_000

/** Display names in webhook author/content fields. */
export const DISCORD_NAME_MAX_LENGTH = 24

export function sanitizeDiscordText(raw: unknown, maxLen: number = FEEDBACK_MAX_LENGTH): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/@everyone/gi, '')
    .replace(/@here/gi, '')
    .replace(/<@!?&?\d+>/g, '')
    .replace(/@/g, '')
    .replace(/[*_`~|\\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/^\s+|\s+$/g, '')
    .slice(0, maxLen)
}

export function sanitizeDiscordName(raw: unknown): string {
  return sanitizeDiscordText(raw, DISCORD_NAME_MAX_LENGTH).replace(/\s+/g, ' ')
}

/**
 * Sliding-window global limiter. Returns the pruned list (with `now` appended
 * when the event is allowed). Callers should replace their stored list.
 */
export function allowGlobalEvent(
  times: readonly number[],
  now: number,
  limit: number = GLOBAL_FEEDBACK_LIMIT,
  windowMs: number = GLOBAL_FEEDBACK_WINDOW_MS,
): { allowed: boolean; times: number[] } {
  if (![now, limit, windowMs].every(Number.isFinite) || limit < 1 || windowMs < 0) {
    return { allowed: false, times: times.filter((t) => Number.isFinite(t)) }
  }
  const cut = now - windowMs
  const next = times.filter((t) => t > cut)
  if (next.length >= limit) return { allowed: false, times: next }
  next.push(now)
  return { allowed: true, times: next }
}

/** Always disable Discord mention parsing on webhook payloads. */
export const NO_MENTIONS = { parse: [] as string[] }

export function mailboxWebhookBody(message: string, authorName: string): object {
  return {
    embeds: [{
      description: sanitizeDiscordText(message),
      author: { name: sanitizeDiscordName(authorName) || 'player' },
      color: 3447003,
    }],
    allowed_mentions: NO_MENTIONS,
  }
}
