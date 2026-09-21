import { describe, expect, test } from "bun:test"
import {
  DEFAULT_MAX_DELAY_MS,
  detectResetDelayMs,
  fallbackDelayMs,
  formatDuration,
  getHeader,
  parseErrorMessageMs,
  parseResetHeaderMs,
  parseRetryAfterMs,
  sanitizeDelayMs,
} from "./retry-after.ts"

// Fixed clock: 2026-09-21T12:00:00Z.
const NOW = Date.UTC(2026, 8, 21, 12, 0, 0)

describe("parseRetryAfterMs", () => {
  test("Retry-After: 120 (seconds)", () => {
    expect(parseRetryAfterMs("120", NOW)).toBe(120_000)
  })
  test("Retry-After HTTP-date", () => {
    expect(parseRetryAfterMs("Mon, 21 Sep 2026 18:00:00 GMT", NOW)).toBe(6 * 3_600_000)
  })
  test("expired HTTP-date yields 0", () => {
    expect(parseRetryAfterMs("Mon, 21 Sep 2026 11:00:00 GMT", NOW)).toBe(0)
  })
  test("malformed values", () => {
    expect(parseRetryAfterMs(null, NOW)).toBeUndefined()
    expect(parseRetryAfterMs("", NOW)).toBeUndefined()
    expect(parseRetryAfterMs("soon", NOW)).toBeUndefined()
    expect(parseRetryAfterMs("-5", NOW)).toBeUndefined()
    expect(parseRetryAfterMs("not a date )(", NOW)).toBeUndefined()
  })
})

describe("parseResetHeaderMs", () => {
  test("Unix-second reset timestamp", () => {
    // 2026-09-21T14:30:00Z
    const seconds = Math.floor(Date.UTC(2026, 8, 21, 14, 30, 0) / 1000)
    expect(parseResetHeaderMs("x-ratelimit-reset", String(seconds), NOW)).toBe(2.5 * 3_600_000)
  })
  test("Unix-millisecond reset timestamp", () => {
    const ms = Date.UTC(2026, 8, 21, 12, 5, 0)
    expect(parseResetHeaderMs("x-ratelimit-reset", String(ms), NOW)).toBe(5 * 60_000)
  })
  test("relative reset seconds", () => {
    expect(parseResetHeaderMs("x-ratelimit-reset", "90", NOW)).toBe(90_000)
  })
  test("retry-after-ms is milliseconds-until-reset", () => {
    expect(parseResetHeaderMs("retry-after-ms", "1500", NOW)).toBe(1500)
  })
  test("date-string reset header", () => {
    expect(parseResetHeaderMs("x-ratelimit-reset", "Mon, 21 Sep 2026 13:00:00 GMT", NOW)).toBe(3_600_000)
  })
  test("expired reset timestamp yields 0", () => {
    const pastSeconds = Math.floor(Date.UTC(2026, 8, 21, 10, 0, 0) / 1000)
    expect(parseResetHeaderMs("x-ratelimit-reset", String(pastSeconds), NOW)).toBe(0)
    expect(parseResetHeaderMs("x-ratelimit-reset", String(Date.UTC(2026, 8, 21, 10, 0, 0)), NOW)).toBe(0)
  })
  test("malformed values", () => {
    expect(parseResetHeaderMs("x-ratelimit-reset", null, NOW)).toBeUndefined()
    expect(parseResetHeaderMs("x-ratelimit-reset", "", NOW)).toBeUndefined()
    expect(parseResetHeaderMs("x-ratelimit-reset", "abc", NOW)).toBeUndefined()
    expect(parseResetHeaderMs("x-ratelimit-reset", "-30", NOW)).toBeUndefined()
  })
  test("very large bogus values are rejected", () => {
    // Far-future timestamp (year 2286+) and absurd relative value.
    expect(parseResetHeaderMs("x-ratelimit-reset", "99999999999", NOW)).toBeUndefined()
    expect(parseResetHeaderMs("x-ratelimit-reset", "99999999999999", NOW)).toBeUndefined()
    expect(parseResetHeaderMs("x-ratelimit-reset", "Mon, 21 Sep 2036 12:00:00 GMT", NOW)).toBeUndefined()
  })
})

describe("parseErrorMessageMs", () => {
  test("retry in 30 seconds", () => {
    expect(parseErrorMessageMs("Rate limited. Please retry in 30 seconds.", NOW)).toBe(30_000)
  })
  test("retry in 15m", () => {
    expect(parseErrorMessageMs("Too many requests, retry in 15m", NOW)).toBe(15 * 60_000)
  })
  test("resets in 4h 20m", () => {
    expect(parseErrorMessageMs("Quota exhausted, resets in 4h 20m", NOW)).toBe((4 * 60 + 20) * 60_000)
  })
  test("try again in 2 hours 13 minutes", () => {
    expect(parseErrorMessageMs("Slow down, try again in 2 hours 13 minutes", NOW)).toBe((2 * 60 + 13) * 60_000)
  })
  test("reset in 4 hours", () => {
    expect(parseErrorMessageMs("Usage limit hit, reset in 4 hours", NOW)).toBe(4 * 3_600_000)
  })
  test("ISO reset timestamp", () => {
    expect(parseErrorMessageMs("quota resets at 2026-09-22T03:00:00Z, slow down", NOW)).toBe(15 * 3_600_000)
  })
  test("clock time reset at 11:30 PM (UTC)", () => {
    // NOW is 12:00 UTC -> next 23:30 UTC is 11.5h away.
    expect(parseErrorMessageMs("Quota exceeded, reset at 11:30 PM", NOW)).toBe(11.5 * 3_600_000)
  })
  test("missing reset information", () => {
    expect(parseErrorMessageMs("Too many requests", NOW)).toBeUndefined()
    expect(parseErrorMessageMs("", NOW)).toBeUndefined()
    expect(parseErrorMessageMs(null, NOW)).toBeUndefined()
    // Numbers without rate-limit language are ignored.
    expect(parseErrorMessageMs("Request took 45 seconds to process", NOW)).toBeUndefined()
  })
  test("implausibly large durations are rejected", () => {
    expect(parseErrorMessageMs("Rate limited, retry in 99999 hours", NOW)).toBeUndefined()
  })
})

describe("detectResetDelayMs precedence", () => {
  test("retry-after beats reset header", () => {
    const detected = detectResetDelayMs(
      {
        retryAfter: "60",
        headers: { "x-ratelimit-reset": String(Math.floor(Date.UTC(2026, 8, 21, 15, 0, 0) / 1000)) },
        message: "retry in 5 minutes",
      },
      NOW,
    )
    expect(detected).toEqual({ delayMs: 60_000, source: "retry-after" })
  })
  test("reset header beats error message", () => {
    const detected = detectResetDelayMs(
      {
        headers: { "x-ratelimit-reset": "120" },
        message: "quota resets in 4h 20m, slow down",
      },
      NOW,
    )
    expect(detected?.source).toBe("reset-header:x-ratelimit-reset")
    expect(detected?.delayMs).toBe(120_000)
  })
  test("longest valid reset header wins", () => {
    const detected = detectResetDelayMs(
      {
        headers: { "x-ratelimit-reset-requests": "60", "x-ratelimit-reset-tokens": "300" },
      },
      NOW,
    )
    expect(detected).toEqual({ delayMs: 300_000, source: "reset-header:x-ratelimit-reset-tokens" })
  })
  test("header lookup is case-insensitive", () => {
    const detected = detectResetDelayMs({ headers: { "X-RateLimit-Reset": "45" } }, NOW)
    expect(detected?.delayMs).toBe(45_000)
  })
  test("falls back to error message when headers are useless", () => {
    const detected = detectResetDelayMs(
      { headers: { "x-ratelimit-reset": "bogus" }, message: "Too many requests, retry in 15m" },
      NOW,
    )
    expect(detected).toEqual({ delayMs: 15 * 60_000, source: "error-message" })
  })
  test("missing reset information", () => {
    expect(detectResetDelayMs({}, NOW)).toBeUndefined()
    expect(detectResetDelayMs({ headers: {}, message: "nope" }, NOW)).toBeUndefined()
  })
  test("getHeader supports Headers instances and arrays", () => {
    expect(getHeader(new Headers({ "Retry-After": "7" }), "retry-after")).toBe("7")
    expect(getHeader({ "X-Ratelimit-Reset": ["90"] }, "x-ratelimit-reset")).toBe("90")
  })
})

describe("delay policy helpers", () => {
  test("fallback backoff doubles and is bounded", () => {
    expect(fallbackDelayMs(1, 60_000, 300_000)).toBe(60_000)
    expect(fallbackDelayMs(2, 60_000, 300_000)).toBe(120_000)
    expect(fallbackDelayMs(3, 60_000, 300_000)).toBe(240_000)
    expect(fallbackDelayMs(4, 60_000, 300_000)).toBe(300_000)
    expect(fallbackDelayMs(99, 60_000, 300_000)).toBe(300_000)
  })
  test("sanitizeDelayMs rejects garbage", () => {
    expect(sanitizeDelayMs(Number.NaN, DEFAULT_MAX_DELAY_MS)).toBeUndefined()
    expect(sanitizeDelayMs(Infinity, DEFAULT_MAX_DELAY_MS)).toBeUndefined()
    expect(sanitizeDelayMs(-1, DEFAULT_MAX_DELAY_MS)).toBeUndefined()
    expect(sanitizeDelayMs("60" as unknown as number, DEFAULT_MAX_DELAY_MS)).toBeUndefined()
    expect(sanitizeDelayMs(9e15, 1000)).toBe(1000)
  })
  test("formatDuration", () => {
    expect(formatDuration(5_000)).toBe("5s")
    expect(formatDuration((3 * 60 + 14) * 60_000 + 5_000)).toBe("3h 14m 5s")
    expect(formatDuration(0)).toBe("0s")
  })
})
