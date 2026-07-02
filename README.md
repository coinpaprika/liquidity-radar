# LiquidityRadar

[![CI](https://github.com/coinpaprika/liquidity-radar/actions/workflows/ci.yml/badge.svg)](https://github.com/coinpaprika/liquidity-radar/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/coinpaprika/liquidity-radar)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/coinpaprika/liquidity-radar)

Real-time alerts when DEX liquidity drains or spikes. Watch a pool get rugged
the block it happens, not 30 seconds later when the money is already gone.

**[Live demo: watch pools rug in real time &rarr;](https://liquidity-radar-dexpaprika.coinpaprika.workers.dev)**

On its first night running, it caught a fresh Base pool draining **-97.3%
($67k) in a single block**. That's the kind of event it exists for.

Built on the [DexPaprika](https://dexpaprika.com) Reserve Stream API. **No API
key. No KYC. Free.** Forking it is editing one JSON file and running one
deploy command; the whole stack is a single Worker on a free, keyless stream.

## See it work in 5 seconds

No install, no signup. Paste this and watch reserves stream live:

```bash
curl -N "https://streaming.dexpaprika.com/sse/reserves?method=token_reserves&chain=ethereum&address=0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
```

Those are live WETH reserve changes, block by block, with USD deltas already
attached. LiquidityRadar turns that firehose into "🚨 someone just pulled $1.2M
out of this pool."

## Run it in your terminal

Needs Node 18+. Three commands, no config. It ships with a curated watchlist
of 58 pools across 6 chains:

```bash
git clone https://github.com/coinpaprika/liquidity-radar
cd liquidity-radar && npm install
npm run radar
```

```
LiquidityRadar (live)
  data: DexPaprika reserve stream (free, no key): dexpaprika.com
  alerting on moves ≥ $10.0K and ≥ 20.0% of reserve
  …
2026-06-10T23:27:00.000Z
🚨 DRAIN · WETH/INPAY (Uniswap V4) on base
-$67.0K (-97.3%) · reserve now $1.9K
pool 0x8b47…cedf · block 47172360
```

Alerts at the default thresholds are rare by design. A 20% single-block move
is an event, not a Tuesday. To watch it work, lower the bar (alerts usually
start within a minute or two):

```bash
npm run radar -- --verbose --min 1000 --pct 0.005   # every tick, and watch them turn into alerts
```

At demo thresholds the same pool can re-alert every block it oscillates; the
CLI deliberately has no cooldown (the deployable feed below has one).

## Deploy your own 24/7 radar

The `feed/` Worker watches around the clock, keeps a public status page of
everything it catches, and (optionally) sends alerts to any webhook:
Discord, Slack, your own service. You need a free
[Cloudflare account](https://dash.cloudflare.com/sign-up); the radar fits the
free plan. Two ways in:

**One-click:** hit the button and Cloudflare copies this repo into your GitHub
account and deploys it. Then edit `watchlist.json` in that new repo (your
pools, your thresholds; that one file is the whole configuration) and push;
Workers Builds redeploys automatically.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/coinpaprika/liquidity-radar)

**Or from the terminal:**

```bash
git clone https://github.com/<you>/liquidity-radar   # your fork
cd liquidity-radar
npx wrangler login        # opens a browser; in Codespaces/CI set CLOUDFLARE_API_TOKEN instead
# edit watchlist.json
npx wrangler deploy
```

First deploy may ask you to pick an account and register a free
`<name>.workers.dev` subdomain. Your radar is then live at
`liquidity-radar-dexpaprika.<name>.workers.dev` with a status page showing
every catch, timestamped, surviving restarts.

**Send alerts anywhere.** Out of the box the radar is watch-only: catches
accumulate on your status page and nothing leaves the worker. Point
`WEBHOOK_URL` at any webhook to change that. Discord works in under a
minute (Server Settings → Integrations → Webhooks → copy URL):

```bash
npx wrangler secret put WEBHOOK_URL      # paste your Discord (or any) webhook
npx wrangler deploy
```

Discord URLs get Discord's message shape automatically; anything else
receives `{text, alert}` JSON for Telegram bridges, Slack, your trading bot,
whatever you build. A send gate keeps any channel sane: dedup per pool+block,
30-min per-pool cooldown, hourly cap, and automatic pauses on rate limits.

## The watchlist

One file, `watchlist.json`. Forking is editing it.

```json
{
  "minUsd": 10000,
  "pctThreshold": 0.2,
  "watch": [
    { "method": "pool_reserves",  "chain": "ethereum", "address": "0x88e6…5640", "label": "USDC/WETH 0.05%" },
    { "method": "token_reserves", "chain": "ethereum", "address": "0xc02a…6cc2", "label": "WETH" }
  ]
}
```

- `pool_reserves` follows one pool. A swap moves one side up and the other
  down, netting near zero, so swaps never false-trigger. A real LP pull
  negates both legs at once. **Use pool mode for rug detection.**
- `token_reserves` follows a token across every pool it trades in. It flags
  any large one-sided move (including big swaps), so its alerts say
  "RESERVE DROP", not "DRAIN".
- `minUsd` / `pctThreshold` scale together: on a $50M blue-chip pool the
  default 20% bar means an eight-figure event; on a $100k memecoin pool a
  $20k pull trips it.
- The whole list rides multiplexed connections (25 subscriptions each), on
  every chain DexPaprika indexes: Ethereum, Solana, Base, BSC, Arbitrum,
  Sui, and 29 more.

## Who this is for

- **DeFi traders**: get drain alerts before the timeline does.
- **Security researchers**: monitor a set of tokens for exit patterns.
- **Developers**: `core/` is a tiny, dependency-free SSE engine to build on.
  See [ARCHITECTURE.md](ARCHITECTURE.md) for how it all fits together, or
  open a ready dev container:

  [![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/coinpaprika/liquidity-radar)

## What this costs to run

- **CLI:** nothing. The [DexPaprika API](https://dexpaprika.com) is free,
  keyless, no signup, generous limits (25 subscriptions per connection,
  10 streams per IP).
- **The 24/7 feed:** fits Cloudflare's free plan with thin headroom; the
  $5/month Workers Paid plan is the comfortable choice. Watchlist size
  doesn't change the cost.

## Built on DexPaprika

LiquidityRadar runs entirely on free, public, keyless DexPaprika data. Live
reserves come from the Reserve Stream, a single SSE connection
(`POST streaming.dexpaprika.com/sse/reserves`) that multiplexes every watched
pool, so a drain shows up the block it happens. Pool discovery uses the REST API
(`GET /networks/{chain}/pools/search`) to pick which pools are worth watching.
That's the whole stack: those two calls plus one Cloudflare Worker and a Durable
Object you deploy with a single command. No backend to run, no key to wait for.
The same stream feeds price tickers, arbitrage bots, alert systems, whatever you
want to build.

Every number this radar shows comes from the free DexPaprika data layer:

- [dexpaprika.com](https://dexpaprika.com): real-time DEX data, 35 chains
- [Streaming docs](https://docs.dexpaprika.com): the Reserve Stream API
- [agents.dexpaprika.com](https://agents.dexpaprika.com): agent-native onboarding

## License

MIT

---

If this catches something for you, a ⭐ helps other people find it.
