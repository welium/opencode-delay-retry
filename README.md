# delayed-retry

Local global OpenCode V2 plugin. When any model/provider returns HTTP 429,
wait until the provider says requests can be attempted again (plus a small
safety margin) and let OpenCode retry the same failed request once — instead
of burning OpenCode's hard-limited retry attempts on rapid re-tries.

## Install

After pushing this repo to GitHub, install it as a global package plugin:

```sh
opencode plugin add github:<you>/opencode-delay-retry
```

For local development, point OpenCode at a checkout instead:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": [{ "package": "/path/to/opencode-delay-retry" }],
}
```

or drop it under the global auto-discovered directory:

```text
~/.config/opencode/plugins/delayed-retry/
```

## How it works

- `session.hook("http.response")` observes 429 responses and captures
  rate-limit metadata keyed by session/provider/model/request-kind: an
  allowlist of reset headers plus a truncated (2 KB) body snippet read via
  `response.clone()`, so the original response stays intact. Entries expire
  after 10 minutes, are capped (200 keys × 3 entries), and swept lazily —
  no unbounded memory growth, no timers keeping the process alive.
- `session.hook("retry")` (unscoped — all providers) only acts on
  `event.error.status === 429` and sets
  `event.decision = { retry: true, delay: calculatedDelayMs }`.
- WebSocket-backed providers are not hooked directly (those hooks are
  experimental); if their failures reach the normal `retry` hook with status
  429, they are handled through the error-message path.

## Reset detection (generic, no provider-specific code)

Precedence in `retry-after.ts`:

1. Standard `Retry-After`: delay seconds (`3600`) or HTTP-date.
2. Reset headers (case-insensitive): `x-ratelimit-reset`,
   `x-rate-limit-reset`, `ratelimit-reset`, `x-ratelimit-reset-requests`,
   `x-ratelimit-reset-tokens`, `retry-after-ms`, and a few `*-ms` variants.
   Values may be Unix seconds, Unix milliseconds (≥ 1e12), relative
   seconds, relative milliseconds (`*-ms` headers), or date strings.
   Implausibly far values (> `maxDelayMs`) are rejected, not trusted.
   When several buckets are present, the longest valid one wins so a single
   delayed retry covers every exhausted bucket.
3. Error body/message: relative forms (`retry after 45 seconds`,
   `retry in 12m`, `resets in 3h 42m`, `reset in 4 hours`), absolute ISO
   timestamps (`quota resets at 2026-09-22T03:00:00Z`), and clock times
   (`reset at 11:30 PM`, UTC). Parsing requires rate-limit language nearby
   and only reads durations from a short window after the first keyword.

## Fallback (429 with no trustworthy reset info)

1. If OpenCode already considers the failure retryable, its decision/delay
   is preserved untouched.
2. Otherwise a modest bounded exponential backoff:
   `fallbackDelayMs * 2^(attempt-1)`, capped at `fallbackMaxDelayMs`
   (defaults 60s → … → 5m). No tight retry loop, no invented multi-hour wait.

Short delays (≤ 60s) get up to `jitterMs` of random jitter; multi-hour quota
resets never do.

## Configuration

Optional, via the normal plugin options mechanism:

```jsonc
// opencode.jsonc
{
  "plugins": [
    {
      "package": "github:<you>/opencode-delay-retry",
      "options": {
        "safetyMarginMs": 5000,
        "fallbackDelayMs": 60000,
        "fallbackMaxDelayMs": 300000,
        "maxDelayMs": 86400000,
        "jitterMs": 2000,
        "debug": false,
      },
    },
  ],
}
```

No configuration is required; defaults work out of the box.
`maxDelayMs` (default 24h) caps any scheduled delay as protection against
parser mistakes — legitimate multi-hour quota resets are preserved, not
capped to minutes.

## Logging

Concise `[delayed-retry]` lines with provider/model, computed delay, and
reset source (`retry-after`, `reset-header:<name>`, `error-message`).
Never logs headers, bodies, API keys, or secrets. Set `debug: true` for
capture details.

## Limitation: OpenCode's hard retry-attempt limit

The V2 `retry` hook cannot raise OpenCode's built-in maximum physical
attempt count. This plugin is designed so a known long reset consumes one
long delayed retry (`429 → sleep ~4h → one retry`) instead of many short
wakes that exhaust the attempt budget. If the quota needs more retries than
OpenCode's hard limit allows after the wait, the job still terminates —
but only after waiting correctly, not after pointlessly hammering the
provider. Matching a failure to its `http.response` metadata is
best-effort (keyed by session/provider/model/kind, newest-first);
concurrent same-model requests can interleave, in which case any entry with
usable reset info is preferred.

## Development

```sh
bun test        # parser + policy tests (31 tests)
bunx tsc --noEmit
```
