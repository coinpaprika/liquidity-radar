#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createRadar,
  formatAlert,
  pct as fmtPct,
  shortAddr,
  usd,
  validateRadarConfig,
  type RadarConfig,
  type ReserveEvent,
  type WatchEntry,
} from "../../core/src/index.js";

interface Args {
  file: string;
  min?: number;
  pct?: number;
  verbose: boolean;
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { file: "", verbose: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--verbose" || a === "-v") args.verbose = true;
    else if (a === "--min") args.min = Number(argv[++i]);
    else if (a === "--pct") args.pct = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else positional.push(a);
  }
  if (args.min !== undefined && (!Number.isFinite(args.min) || args.min < 0)) {
    fail("--min requires a non-negative number (USD), e.g. --min 25000");
  }
  if (args.pct !== undefined && (!Number.isFinite(args.pct) || args.pct < 0 || args.pct > 1)) {
    fail("--pct is a fraction of the prior reserve between 0 and 1 (0.1 = 10%)");
  }
  args.file = positional[0] ?? "watchlist.json";
  return args;
}

function printHelp(): void {
  console.log(`liquidity-radar: watch DEX reserves for drains and big adds

Usage:
  liquidity-radar [watchlist.json] [options]

Options:
  --min <usd>    min absolute USD move (default from file)
  --pct <0-1>    min fraction of prior reserve (default from file)
  --verbose, -v  print every reserve tick, not just alerts
  --help, -h     show this help

Data: DexPaprika reserve stream (free, no key, no KYC): dexpaprika.com
The shipped watchlist.json alerts at \$10k and 20% of reserve; big pools
rarely move that much in a block. To watch it work right away:
  liquidity-radar watchlist.json --verbose --min 1000 --pct 0.005`);
}

function loadConfig(file: string): RadarConfig {
  const path = resolve(process.cwd(), file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`${file}: ${String(err)}\n  (try: liquidity-radar watchlist.example.json)`);
  }
  const errors = validateRadarConfig(raw);
  if (errors.length > 0) {
    fail(`${file} is invalid:\n  - ${errors.join("\n  - ")}`);
  }
  return raw as RadarConfig;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.file);

  if (args.min !== undefined) config.minUsd = args.min;
  if (args.pct !== undefined) config.pctThreshold = args.pct;
  const minUsd = config.minUsd ?? 25_000;
  const pctThreshold = config.pctThreshold ?? 0.1;

  console.log("LiquidityRadar (live)");
  console.log("  data: DexPaprika reserve stream (free, no key): dexpaprika.com");
  console.log(
    `  alerting on moves ≥ ${usd(minUsd)} and ≥ ${(pctThreshold * 100).toFixed(1)}% of reserve`,
  );
  for (const w of config.watch) {
    console.log(`  watching ${w.method} ${w.label ?? w.address} (${w.chain})`);
  }
  console.log("  Ctrl-C to stop\n");

  let events = 0;
  let alerts = 0;
  let stopping = false;

  const tick = (event: ReserveEvent, entry: WatchEntry) => {
    events++;
    if (events === 1 && !args.verbose) {
      console.log("✓ connected, streaming live reserve events (quiet until a threshold hits)\n");
    }
    if (!args.verbose) return;
    const name = entry.label ?? shortAddr(entry.address);
    if (event.type === "token_reserves") {
      console.log(
        `· ${name} ${usd(event.delta_usd)} (reserve ${usd(event.reserve_usd)}) blk ${event.block}`,
      );
    } else {
      const prev = event.total_reserve_usd - event.total_delta_usd;
      const p = prev > 0 ? event.total_delta_usd / prev : 0;
      console.log(
        `· ${name} net ${usd(event.total_delta_usd)} (${fmtPct(p)}, reserve ${usd(event.total_reserve_usd)}) blk ${event.block}`,
      );
    }
  };

  const radar = createRadar(
    { ...config, minUsd, pctThreshold },
    {
      onAlert: (alert) => {
        alerts++;
        const ts = new Date(alert.timestamp * 1000).toISOString();
        console.log(`${ts}\n${formatAlert(alert)}\n`);
      },
      onEvent: tick,
      onFatal: (err, entries) => {
        const names = entries.map((e) => e.label ?? shortAddr(e.address)).join(", ");
        console.error(`✗ subscription stopped (${names}): ${err.message}`);
        console.error("  fix that watchlist entry and restart\n");
      },
      onWarning: (msg) => console.error(`⚠ ${msg}`),
    },
  );

  const heartbeat = args.verbose
    ? undefined
    : setInterval(() => {
        console.log(`… still connected · ${events} reserve events seen · ${alerts} alerts`);
      }, 60_000);
  heartbeat?.unref?.();

  const stop = () => {
    stopping = true;
    console.log("\nstopping…");
    radar.stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await radar.start();
  if (heartbeat) clearInterval(heartbeat);
  if (!stopping) {
    fail("all subscriptions have ended, see errors above");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
