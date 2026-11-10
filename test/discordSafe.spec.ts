import {
  FEEDBACK_MAX_LENGTH,
  GLOBAL_FEEDBACK_LIMIT,
  GLOBAL_FEEDBACK_WINDOW_MS,
  allowGlobalEvent,
  mailboxWebhookBody,
  sanitizeDiscordName,
  sanitizeDiscordText,
} from '../src/server/discordSafe'

describe('sanitizeDiscordText', () => {
  it('strips @everyone, @here, user mentions, leftover @, and markdown', () => {
    expect(sanitizeDiscordText('Hello @everyone and @here')).toBe('Hello and')
    expect(sanitizeDiscordText('ping <@123> and <@&456>')).toBe('ping and')
    expect(sanitizeDiscordText('use *bold* and `code`')).toBe('use bold and code')
  })

  it('strips control characters, caps length, and rejects non-strings', () => {
    expect(sanitizeDiscordText('ok\u0000go')).toBe('okgo')
    expect(sanitizeDiscordText('a'.repeat(FEEDBACK_MAX_LENGTH + 20)).length).toBe(FEEDBACK_MAX_LENGTH)
    expect(sanitizeDiscordText(null)).toBe('')
    expect(sanitizeDiscordText(123)).toBe('')
  })

  it('caps display names', () => {
    expect(sanitizeDiscordName('@everyone' + 'x'.repeat(40)).length).toBeLessThanOrEqual(24)
    expect(sanitizeDiscordName('  ile  ')).toBe('ile')
  })
})

describe('allowGlobalEvent', () => {
  it('allows up to the window limit and then blocks', () => {
    let times: number[] = []
    const start = 1_000_000
    for (let i = 0; i < GLOBAL_FEEDBACK_LIMIT; i++) {
      const r = allowGlobalEvent(times, start + i * 100)
      expect(r.allowed).toBe(true)
      times = r.times
    }
    expect(allowGlobalEvent(times, start + 1000).allowed).toBe(false)
  })

  it('prunes events outside the window', () => {
    const start = 1_000_000
    const times = [start]
    const later = start + GLOBAL_FEEDBACK_WINDOW_MS + 1
    const r = allowGlobalEvent(times, later)
    expect(r.allowed).toBe(true)
    expect(r.times).toEqual([later])
  })
})

describe('mailboxWebhookBody', () => {
  it('sends a sanitized embed and disables mention parsing', () => {
    const body = mailboxWebhookBody('hi @everyone', '@here spoof') as {
      allowed_mentions: { parse: string[] }
      embeds: Array<{ description: string; author: { name: string } }>
    }
    expect(body.allowed_mentions).toEqual({ parse: [] })
    expect(body.embeds[0].description).toBe('hi')
    expect(body.embeds[0].author.name).not.toMatch(/@/)
  })
})
