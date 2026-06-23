# How LiquidityRadar works

```
core/   the engine: subscribe, detect, emit alerts. Zero dependencies.
feed/   Cloudflare Worker + Durable Object, the 24/7 alert feed
cli/    terminal frontend around core
```

`core` runs anywhere `fetch` exists: Node 18+, Cloudflare Workers, Deno, the
browser.

## Data source

All data comes from the [DexPaprika Reserve Stream API](https://docs.dexpaprika.com)
(`streaming.dexpaprika.com/sse/reserves`). Free, no API key, no signup.
Reserve changes arrive block-by-block as SSE events with USD deltas already
computed server-side, so the client does no price math.

Captured event shapes:

`event: token_reserves`, one token across all its pools:
```json
{"chain":"ethereum","token_id":"0xc02a…","reserve":"3243…","delta":"-1722…",
 "block":"25286202","price_usd":1618.74,"reserve_usd":525025172.27,
 "delta_usd":-27881.21,"updated_at":1781084315,"timestamp":1781084317}
```

`event: pool_reserves`, one pool with per-token legs plus totals:
```json
{"chain":"ethereum","pool_id":"0x88e6…","block":"25286203","previous_block":"…",
 "tokens":[{"token_id":"…","delta_usd":46015.11,"reserve_usd":19396869.94}, …],
 "total_reserve_usd":84031158.86,"total_delta_usd":84.37, …}
```

Numeric reserve strings stay strings to protect JS float precision; events
carry `request_id:` for multiplex routing; heartbeat pings keep connections
honest.

## Transport: one connection, up to 25 subscriptions

The API multiplexes up to 25 subscriptions per POST connection and caps
streams at 10 per IP. `createRadar` chunks the watchlist into groups of 25 or fewer:
a 58-pool watchlist uses 3 connections, not 58. Events route back to entries
by `request_id` (the index in the POST array), with a chain+address fallback.

Connection care, learned in production:

- Backoff resets only after the first parsed SSE message, because HTTP 200 alone
  proves nothing (proxies can 200-and-close).
- In-stream `error` events split two ways: capacity problems ("stream limit
  exceeded") retry with backoff; subscription problems ("token not found")
  stop that chunk permanently and surface the server's message. Treating
  limits as fatal once silenced 8 pools for a night.
- Permanent HTTP 4xx stops with the server's actual error text instead of
  retrying forever; 408/429/5xx keep retrying.
- Early consumer exit cancels the reader so connections never leak.

## Detection

- `prevReserveUsd = total_reserve_usd - total_delta_usd`
- `pct = deltaUsd / prevReserveUsd`
- Alert when `|deltaUsd| >= minUsd` AND `|pct| >= pctThreshold`

A swap moves one leg up and the other down, netting `total_delta_usd` to ~0,
so swaps never false-trigger pool mode. An LP pull negates both legs at once.
That asymmetry is the whole detector.

Honesty rule: token-scope alerts are one-sided by nature (a whale buy also
drops one-sided reserves), so they render as "📉 RESERVE DROP", never
"🚨 DRAIN". Only pool-scope drains get the siren.

Field note from the first soak night: JIT liquidity bots on major pools churn
±4% per block. The default 20% threshold clears that plumbing noise with a 5x
margin while a rugged fresh pool still trips it easily.

## The feed Worker

A single Durable Object holds the SSE connections (kept alive by a 30s alarm
chain plus a 5-minute cron as bootstrap/backstop) and gates alerts before
they reach your webhook:

- fail-closed: without `WEBHOOK_URL` nothing leaves the worker; catches
  just accumulate on the status page
- dedup on `subject:block:kind` (24h TTL), per-subject cooldown, global
  hourly cap, and a pause honoring webhook 429s, so a volatile pool can't
  flood a channel
- every catch persists to DO storage with a timestamp and shows on the
  status page, including the ones the gate skipped and why
- changing thresholds starts a fresh catch epoch so the page always reads as
  one coherent experiment

### Choosing what to watch

The free reserve stream holds about 74 pools at once (three connections, 25
subscriptions each). LiquidityRadar fills those slots in two stages. A cheap
REST scanner *discovers candidates*: young, active, small-to-mid pools, ranked
by 24h volume. It does not read growth from REST, because `liquidity_usd`
barely moves minute to minute. The stream then *pins the movers*, any pool
currently rising, draining, or mid-confirmation, so none is dropped mid-event,
and *rotates the rest* through the candidate list. A cursor advances every five
minutes, so 74 slots sweep far more than 74 pools over time.

"Rising" and "draining" are both read from the stream's real, quote-valued
reserves, the same data path that confirms a drain. A pool that pumps then
dumps is flagged by the same eyes that catch the cliff. An API key lifts the
cap to roughly 175 pools, but nothing here needs one: the design stands on the
free tier.

## What it costs to run

CLI: nothing. The API is free and keyless. The 24/7 feed: an always-on DO
uses ~10,800 GB-s/day, which fits Cloudflare's free plan (13,000 GB-s/day cap)
with thin headroom; the $5/month Workers Paid plan is the comfortable choice.
Watchlist size doesn't change the cost.
