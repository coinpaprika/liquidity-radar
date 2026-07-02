# Contributing

Thanks for looking under the hood. The codebase is small on purpose:

```
core/   the engine: zero dependencies, runs anywhere fetch exists
feed/   Cloudflare Worker + Durable Object: the 24/7 alert feed + status page
cli/    thin wrapper around core
```

## Dev setup

```bash
npm install
npm test            # unit tests (SSE parser + detection math)
npm run typecheck   # core + cli + worker
npm run radar -- watchlist.example.json --verbose --min 1 --pct 0   # live smoke test
```

The live smoke test hits the real [DexPaprika API](https://docs.dexpaprika.com)
(free, no key), so you can verify end-to-end behavior in seconds.

## What we're glad to merge

- New alert sinks: keep them out of `core`, and append `DATA_CREDIT` from
  `core/src/format.ts` by default (overridable), same as the webhook sink does
- Detection improvements with a test showing the case they catch
- Chain/DEX-specific quirk fixes, with a captured event in the test
- Docs fixes

## Ground rules

- `core` stays dependency-free. If your change needs a package, it probably
  belongs in `feed/` or `cli/`.
- Every detection change ships with a unit test using a captured event shape.
- Run `npm test && npm run typecheck` before opening the PR.

## Found a false positive or a missed drain?

Open an issue with the pool/token address, chain, and approximate time. Stream
payloads are reproducible, so a block number is the perfect bug report.
