/**
 * delayed-retry: wait out provider 429 rate limits instead of burning
 * OpenCode's hard-limited retry attempts on rapid re-tries.
 *
 * - `http.response` observes 429 responses and captures rate-limit metadata
 *   (a small allowlist of reset headers + a truncated body snippet).
 * - `retry` uses that metadata (plus the error message) to schedule ONE
 *   delayed retry at provider reset + safety margin.
 * - 429s with no trustworthy reset info keep OpenCode's own decision when
 *   retryable, otherwise use bounded exponential fallback backoff.
 *
 * Only HTTP 429 is ever touched. No provider-specific logic: everything is
 * driven by generic Retry-After / reset-header / error-message parsing in
 * ./retry-after.ts.
 */

import { Plugin } from "@opencode/plugin"
import {
  DEFAULT_MAX_DELAY_MS,
  RESET_HEADER_NAMES,
  detectResetDelayMs,
  fallbackDelayMs,
  formatDuration,
  sanitizeDelayMs,
} from "./retry-after.js"

const TAG = "[delayed-retry]"

export interface DelayedRetryOptions {
  /** Extra wait added after a detected provider reset. Default 5000. */
  safetyMarginMs?: number
  /** First fallback delay when no reset info exists. Default 60000. */
  fallbackDelayMs?: number
  /** Upper bound for fallback backoff. Default 300000 (5 minutes). */
  fallbackMaxDelayMs?: number
  /** Hard cap for any scheduled delay. Default 86400000 (24 hours). */
  maxDelayMs?: number
  /** Random 0..jitterMs added only to short delays. Default 2000. */
  jitterMs?: number
  /** Verbose logging. Default false. */
  debug?: boolean
}

interface ResolvedOptions {
  safetyMarginMs: number
  fallbackBaseMs: number
  fallbackMaxMs: number
  maxDelayMs: number
  jitterMs: number
  debug: boolean
}

interface Captured429 {
  capturedAt: number
  /** Lowercased allowlisted reset headers only. Never secrets or full headers. */
  headers: Record<string, string>
  /** Truncated 429 body snippet used only for reset-time parsing. */
  body: string
}

const CAPTURED_HEADERS = ["retry-after", ...RESET_HEADER_NAMES]
const BODY_SNIPPET_LIMIT = 2000
const CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CACHE_KEYS = 200
const MAX_ENTRIES_PER_KEY = 3
const JITTER_THRESHOLD_MS = 60 * 1000

function toNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : (value as number)
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function resolveOptions(raw: DelayedRetryOptions | undefined): ResolvedOptions {
  return {
    safetyMarginMs: toNumber(raw?.safetyMarginMs, 5000, 0, 60 * 60 * 1000),
    fallbackBaseMs: toNumber(raw?.fallbackDelayMs, 60_000, 1000, 60 * 60 * 1000),
    fallbackMaxMs: toNumber(raw?.fallbackMaxDelayMs, 5 * 60 * 1000, 1000, DEFAULT_MAX_DELAY_MS),
    maxDelayMs: toNumber(raw?.maxDelayMs, DEFAULT_MAX_DELAY_MS, 60_000, 7 * 24 * 60 * 60 * 1000),
    jitterMs: toNumber(raw?.jitterMs, 2000, 0, 60_000),
    debug: raw?.debug === true,
  }
}

function cacheKey(sessionID: string, providerID: string, modelID: string, kind: string): string {
  return `${sessionID}\n${providerID}\n${modelID}\n${kind}`
}

/** Short jitter only helps short rate limits; never shift multi-hour quota resets. */
function maybeJitter(delayMs: number, jitterMs: number): number {
  if (jitterMs <= 0 || delayMs > JITTER_THRESHOLD_MS) return delayMs
  return delayMs + Math.floor(Math.random() * jitterMs)
}

export default Plugin.define({
  id: "delayed-retry",
  setup(ctx) {
    const options = resolveOptions(ctx.options as DelayedRetryOptions | undefined)
    const pending = new Map<string, Captured429[]>()
    let lastSweep = Date.now()

    const debug = (...args: unknown[]): void => {
      if (options.debug) console.log(TAG, ...args)
    }

    const sweep = (now: number): void => {
      if (now - lastSweep < 30_000) return
      lastSweep = now
      for (const [key, entries] of pending) {
        const fresh = entries.filter((entry) => now - entry.capturedAt <= CACHE_TTL_MS)
        if (fresh.length === 0) pending.delete(key)
        else if (fresh.length !== entries.length) pending.set(key, fresh)
      }
      // Bound memory even under pathological churn.
      while (pending.size > MAX_CACHE_KEYS) {
        const oldest = pending.keys().next()
        if (oldest.done) break
        pending.delete(oldest.value)
      }
    }

    const store = (key: string, entry: Captured429): void => {
      const entries = pending.get(key) ?? []
      entries.unshift(entry)
      pending.set(key, entries.slice(0, MAX_ENTRIES_PER_KEY))
      sweep(entry.capturedAt)
    }

    const takeFresh = (key: string, now: number): Captured429[] => {
      const entries = pending.get(key) ?? []
      const fresh = entries.filter((entry) => now - entry.capturedAt <= CACHE_TTL_MS)
      if (fresh.length !== entries.length) {
        if (fresh.length === 0) pending.delete(key)
        else pending.set(key, fresh)
      }
      return fresh
    }

    const hooks: Array<{ dispose: () => Promise<void> }> = []

    const register = async (): Promise<void> => {
      hooks.push(
        await ctx.session.hook("http.response", async (event) => {
          try {
            if (event.response.status !== 429) return
            const now = Date.now()
            const headers: Record<string, string> = {}
            for (const name of CAPTURED_HEADERS) {
              const value = event.response.headers.get(name)
              if (value != null && value !== "") headers[name] = value.slice(0, 256)
            }
            let body = ""
            try {
              // Clone so the original response body stays intact.
              body = (await event.response.clone().text()).slice(0, BODY_SNIPPET_LIMIT)
            } catch (error) {
              debug("could not read 429 body snippet:", String(error))
            }
            const key = cacheKey(event.sessionID, event.model.providerID, event.model.id, event.kind)
            store(key, { capturedAt: now, headers, body })
            debug(
              `captured 429 for ${event.model.providerID}/${event.model.id}`,
              `reset headers: ${Object.keys(headers).join(", ") || "none"}`,
            )
          } catch (error) {
            console.log(TAG, "http.response hook failed (ignoring):", String(error))
          }
        }),
      )

      hooks.push(
        await ctx.session.hook("retry", (event) => {
          try {
            if (event.error?.status !== 429) return
            const providerID = event.model.providerID
            const modelID = event.model.id
            const now = Date.now()
            console.log(TAG, `429 from ${providerID}/${modelID} (attempt ${event.attempt})`)

            const key = cacheKey(event.sessionID, providerID, modelID, "primary")
            // Check every kind bucket newest-first; concurrent requests in one
            // session may interleave, so prefer any entry with usable info.
            const candidates = [
              ...takeFresh(key, now),
              ...takeFresh(cacheKey(event.sessionID, providerID, modelID, "compaction"), now),
              ...takeFresh(cacheKey(event.sessionID, providerID, modelID, "generate"), now),
              ...takeFresh(cacheKey(event.sessionID, providerID, modelID, "title"), now),
            ]
            const errorMessage = event.error?.message ?? ""

            let detected: { delayMs: number; source: string } | undefined
            if (candidates.length > 0) {
              for (const entry of candidates) {
                detected = detectResetDelayMs(
                  { headers: entry.headers, message: `${entry.body}\n${errorMessage}` },
                  now,
                  options.maxDelayMs,
                )
                if (detected) break
              }
            } else {
              // No http.response metadata (e.g. a WebSocket-backed provider):
              // still try the retry-hook error message.
              detected = detectResetDelayMs({ message: errorMessage }, now, options.maxDelayMs) ?? undefined
            }

            if (detected) {
              const scheduled = sanitizeDelayMs(detected.delayMs + options.safetyMarginMs, options.maxDelayMs)
              if (scheduled !== undefined) {
                const delay = maybeJitter(scheduled, options.jitterMs)
                event.decision = { retry: true, delay }
                console.log(
                  TAG,
                  `reset detected via ${detected.source} (${formatDuration(detected.delayMs)});`,
                  `retry scheduled in ${formatDuration(delay)}`,
                  `for ${providerID}/${modelID}`,
                )
                return
              }
            }

            if (event.decision?.retry === true) {
              const existing = event.decision.delay
              console.log(
                TAG,
                `429 received; no reset time detected, keeping OpenCode retry policy`,
                `(delay ${formatDuration(existing)}) for ${providerID}/${modelID}`,
              )
              return
            }

            const backoff = fallbackDelayMs(event.attempt, options.fallbackBaseMs, options.fallbackMaxMs)
            const delay = sanitizeDelayMs(maybeJitter(backoff, options.jitterMs), options.maxDelayMs)
            if (delay === undefined) return
            event.decision = { retry: true, delay }
            console.log(
              TAG,
              `429 received; no reset time detected, fallback retry in ${formatDuration(delay)}`,
              `(attempt ${event.attempt}) for ${providerID}/${modelID}`,
            )
          } catch (error) {
            console.log(TAG, "retry hook failed (keeping OpenCode decision):", String(error))
          }
        }),
      )
    }

    const ready = register().catch((error) => {
      console.log(TAG, "failed to register hooks:", String(error))
    })
    void ready

    console.log(TAG, "loaded (safety margin, fallback, max:", `${options.safetyMarginMs}ms,`, `${formatDuration(options.fallbackBaseMs)},`, `${formatDuration(options.maxDelayMs)})`)

    return async () => {
      pending.clear()
      for (const hook of hooks.splice(0)) {
        try {
          await hook.dispose()
        } catch {
          // Unload best-effort.
        }
      }
    }
  },
})
