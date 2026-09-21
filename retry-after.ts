/**
 * Provider-independent rate-limit reset parsing for the delayed-retry plugin.
 *
 * Pure helpers with no OpenCode dependencies so they are easy to unit test.
 * All delays are returned as integer milliseconds >= 0 ("ms from now until
 * the provider says requests can be attempted again").
 *
 * Precedence (most explicit server-provided value wins):
 *   1. Standard `Retry-After` header (delay seconds or HTTP-date).
 *   2. Common rate-limit reset headers (timestamps or relative values).
 *   3. Human-readable reset information in the 429 error body/message.
 */

export const DEFAULT_MAX_DELAY_MS = 24 * 60 * 60 * 1000

/** Unix timestamps (seconds) before this are rejected as implausible. 1e9 = 2001-09-09. */
const MIN_UNIX_SECONDS = 1_000_000_000
/** Values >= 1e12 are interpreted as Unix timestamps in milliseconds. */
const MS_TIMESTAMP_THRESHOLD = 1_000_000_000_000

/**
 * Reset headers examined case-insensitively. "retry-after" is handled
 * separately (highest precedence) and is listed here only for capture.
 */
export const RESET_HEADER_NAMES = [
  "x-ratelimit-reset",
  "x-rate-limit-reset",
  "ratelimit-reset",
  "rate-limit-reset",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "x-rate-limit-reset-requests",
  "x-rate-limit-reset-tokens",
  "retry-after-ms",
  "x-retry-after-ms",
  "x-ratelimit-reset-ms",
] as const

export interface ResetDetectionInput {
  /** Raw value of the standard `Retry-After` header, if present. */
  retryAfter?: string | null
  /** All response headers (any casing). Only reset headers are inspected. */
  headers?: Record<string, string | string[] | undefined> | Headers | null
  /** 429 error body text and/or error message. */
  message?: string | null
}

export interface ResetDetection {
  /** Milliseconds from `now` until the reset. Integer, >= 0. */
  delayMs: number
  /** Where the information came from, e.g. "retry-after" or "reset-header:x-ratelimit-reset". */
  source: string
}

/** Look up a header value case-insensitively. Returns the first value. */
export function getHeader(
  headers: ResetDetectionInput["headers"],
  name: string,
): string | undefined {
  if (!headers) return undefined
  if (typeof (headers as Headers).get === "function") {
    const value = (headers as Headers).get(name)
    return value === null ? undefined : value
  }
  const record = headers as Record<string, string | string[] | undefined>
  const want = name.toLowerCase()
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === want) {
      const value = record[key]
      if (Array.isArray(value)) return value[0]
      return value
    }
  }
  return undefined
}

function isFiniteNonNegative(n: number): boolean {
  return Number.isFinite(n) && n >= 0
}

/**
 * Parse a standard `Retry-After` value: delay seconds ("3600") or an
 * HTTP-date ("Mon, 21 Sep 2026 18:00:00 GMT"). Returns ms until retryable,
 * or undefined when unusable. Expired dates yield 0 (retryable now).
 */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value == null) return undefined
  const trimmed = value.trim()
  if (trimmed === "") return undefined
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed)
    if (!isFiniteNonNegative(seconds)) return undefined
    return Math.floor(seconds * 1000)
  }
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) return undefined
  return Math.max(0, parsed - now)
}

/**
 * Parse one rate-limit reset header value. Recognizes Unix timestamps in
 * seconds or milliseconds, relative seconds-until-reset, relative
 * milliseconds-until-reset (for `*-ms` headers), and date strings.
 * Returns ms until reset, or undefined when the value is missing, malformed,
 * or implausibly far in the future (> maxDelayMs). Expired timestamps yield 0.
 */
export function parseResetHeaderMs(
  name: string,
  value: string | null | undefined,
  now: number = Date.now(),
  maxDelayMs: number = DEFAULT_MAX_DELAY_MS,
): number | undefined {
  if (value == null) return undefined
  const trimmed = value.trim()
  if (trimmed === "") return undefined

  const finish = (delayMs: number): number | undefined => {
    if (!Number.isFinite(delayMs) || delayMs < 0) return undefined
    if (delayMs > maxDelayMs) return undefined
    return Math.floor(delayMs)
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed)
    if (!Number.isFinite(n) || n < 0) return undefined
    const lowerName = name.toLowerCase()
    if (lowerName.includes("-ms") || lowerName.includes("millis")) {
      // Explicit milliseconds-until-reset, e.g. "retry-after-ms: 1500".
      return finish(n)
    }
    if (n >= MS_TIMESTAMP_THRESHOLD) {
      // Unix timestamp in milliseconds.
      const delay = n - now
      return delay <= 0 ? 0 : finish(delay)
    }
    if (n >= MIN_UNIX_SECONDS) {
      // Unix timestamp in seconds. Values this large can never be a
      // plausible relative-seconds value, so timestamp wins.
      const delay = n * 1000 - now
      return delay <= 0 ? 0 : finish(delay)
    }
    // Small numbers are relative seconds-until-reset. (A seconds-timestamp
    // this small would mean 1970, i.e. long expired, so relative wins.)
    return finish(n * 1000)
  }

  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) return undefined
  const delay = parsed - now
  return delay <= 0 ? 0 : finish(delay)
}

const MESSAGE_KEYWORDS =
  /retry|retries|retrying|reset|quota|rate.?limit|try again|slow.?down|cool.?down|too many|exceed|exhaust|throttl|capacity|overload|please wait|wait/i

const ISO_DATETIME =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?Z|[+-]\d{2}:?\d{2}(?::?\d{2})?)?/g

const TIME_OF_DAY_12H = /(?:reset|at|after|around)\s+(?:at\s+)?(\d{1,2})(?::(\d{2})(?::\d{2})?)?\s*(am|pm)\b/i
const TIME_OF_DAY_24H = /(?:reset|at|after)\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::\d{2})?\b/i

const DURATION_TOKEN =
  /(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/gi

const UNIT_TO_MS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  mins: 60 * 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  h: 60 * 60 * 1000,
  hr: 60 * 60 * 1000,
  hrs: 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  hours: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
}

/** Next occurrence (UTC) of a wall-clock time, today or tomorrow. */
function nextTimeOfDayMs(hour: number, minute: number, now: number): number {
  const base = new Date(now)
  let candidate = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour, minute, 0, 0)
  if (candidate <= now) candidate += 24 * 60 * 60 * 1000
  return candidate - now
}

/**
 * Parse human-readable reset information from a 429 error body/message.
 * Handles relative forms ("retry after 45 seconds", "retry in 12m",
 * "resets in 3h 42m"), absolute ISO timestamps ("quota resets at
 * 2026-09-22T03:00:00Z"), and clock times ("reset at 11:30 PM", UTC).
 * Conservative: returns undefined unless the text contains rate-limit
 * language, and durations are only read from a short window after the
 * first rate-limit keyword so unrelated numbers are not summed.
 */
export function parseErrorMessageMs(
  message: string | null | undefined,
  now: number = Date.now(),
  maxDelayMs: number = DEFAULT_MAX_DELAY_MS,
): number | undefined {
  if (message == null) return undefined
  const text = message.slice(0, 4000)
  if (text.trim() === "") return undefined
  if (!MESSAGE_KEYWORDS.test(text)) return undefined

  // 1. Absolute ISO timestamp, e.g. "quota resets at 2026-09-22T03:00:00Z".
  ISO_DATETIME.lastIndex = 0
  let isoMatch: RegExpExecArray | null
  while ((isoMatch = ISO_DATETIME.exec(text)) !== null) {
    const parsed = Date.parse(isoMatch[0].replace(" ", "T"))
    if (Number.isNaN(parsed)) continue
    const delay = parsed - now
    if (delay <= 0) return 0
    if (delay <= maxDelayMs) return Math.floor(delay)
    // Implausibly far match: try the next one instead of giving up.
  }

  // 2. Clock time, e.g. "reset at 11:30 PM" (interpreted as UTC).
  const match12 = TIME_OF_DAY_12H.exec(text)
  if (match12) {
    let hour = Number(match12[1])
    const minute = match12[2] === undefined ? 0 : Number(match12[2])
    const meridiem = match12[3].toLowerCase()
    if (hour >= 1 && hour <= 12 && minute >= 0 && minute <= 59) {
      if (meridiem === "pm" && hour !== 12) hour += 12
      if (meridiem === "am" && hour === 12) hour = 0
      const delay = nextTimeOfDayMs(hour, minute, now)
      if (delay <= maxDelayMs) return Math.floor(delay)
      return undefined
    }
  } else {
    const match24 = TIME_OF_DAY_24H.exec(text)
    if (match24) {
      const hour = Number(match24[1])
      const minute = Number(match24[2])
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        const delay = nextTimeOfDayMs(hour, minute, now)
        if (delay <= maxDelayMs) return Math.floor(delay)
        return undefined
      }
    }
  }

  // 3. Relative durations after the first rate-limit keyword.
  const anchor = text.search(MESSAGE_KEYWORDS)
  const window = text.slice(anchor, anchor + 160)
  const normalized = window
    .replace(/\ban?\s+(second|minute|hour|day)\b/gi, "1 $1")
    .replace(/\ba couple of\s+/gi, "2 ")
  DURATION_TOKEN.lastIndex = 0
  let total = 0
  let found = false
  let token: RegExpExecArray | null
  while ((token = DURATION_TOKEN.exec(normalized)) !== null) {
    const unit = UNIT_TO_MS[token[2].toLowerCase()]
    if (unit === undefined) continue
    total += Number(token[1]) * unit
    found = true
  }
  if (!found) return undefined
  if (!Number.isFinite(total) || total <= 0) return undefined
  if (total > maxDelayMs) return undefined
  return Math.floor(total)
}

/**
 * Detect when a 429 may be retried, honoring precedence:
 * Retry-After > reset headers (longest valid one wins, so a single delayed
 * retry covers every exhausted bucket) > error message.
 */
export function detectResetDelayMs(
  input: ResetDetectionInput,
  now: number = Date.now(),
  maxDelayMs: number = DEFAULT_MAX_DELAY_MS,
): ResetDetection | undefined {
  const retryAfter = input.retryAfter ?? getHeader(input.headers, "retry-after")
  const fromRetryAfter = parseRetryAfterMs(retryAfter, now)
  if (fromRetryAfter !== undefined) {
    return { delayMs: Math.min(fromRetryAfter, maxDelayMs), source: "retry-after" }
  }

  let best: ResetDetection | undefined
  for (const name of RESET_HEADER_NAMES) {
    const raw = getHeader(input.headers, name)
    if (raw == null) continue
    const delayMs = parseResetHeaderMs(name, raw, now, maxDelayMs)
    if (delayMs === undefined) continue
    if (!best || delayMs > best.delayMs) {
      best = { delayMs, source: `reset-header:${name}` }
    }
  }
  if (best) return best

  const fromMessage = parseErrorMessageMs(input.message, now, maxDelayMs)
  if (fromMessage !== undefined) {
    return { delayMs: fromMessage, source: "error-message" }
  }
  return undefined
}

/**
 * Bounded exponential backoff for 429s with no trustworthy reset info.
 * `attempt` is the physical attempt number (initial request is 1).
 */
export function fallbackDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1
  const exponent = Math.min(Math.max(safeAttempt - 1, 0), 5)
  return Math.min(baseMs * 2 ** exponent, maxMs)
}

/** Clamp a candidate delay to a safe integer in [0, maxDelayMs]. */
export function sanitizeDelayMs(candidate: unknown, maxDelayMs: number): number | undefined {
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) return undefined
  return Math.min(Math.floor(candidate), maxDelayMs)
}

/** Humanize a delay, e.g. 11705000 -> "3h 15m 5s". */
export function formatDuration(delayMs: number): string {
  if (!Number.isFinite(delayMs) || delayMs < 0) return "unknown"
  const totalSeconds = Math.max(0, Math.round(delayMs / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`)
  return parts.join(" ")
}
