#!/usr/bin/env node
// Refresh data/metrics.json from Allium.
//
// Usage:  ALLIUM_API_KEY=xxxx node scripts/refresh.mjs
// Get a key at https://app.allium.so/settings/api-keys
//
// Runs each query async (submit -> poll run_id -> fetch rows), then writes metrics.json.
// Schedule it (cron / GitHub Action / Vercel cron) for a self-updating dashboard.
// NOTE: confirm ALLIUM_BASE against current docs (https://docs.allium.so) — the
// explorer query-run REST shape occasionally changes.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const API_KEY = process.env.ALLIUM_API_KEY;
if (!API_KEY) { console.error("Set ALLIUM_API_KEY"); process.exit(1); }

const ALLIUM_BASE = "https://api.allium.so/api/v1/explorer";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../data/metrics.json");

const Q = {
  daily: `
    SELECT ledger_close_time::date AS date,
           COUNT(*) AS "txCount",
           COUNT_IF(t.successful) AS "txSuccess"
    FROM stellar.raw.transactions t
    WHERE ledger_close_time >= DATEADD(day, -90, CURRENT_DATE())
    GROUP BY 1 ORDER BY 1`,
  dailyOps: `
    SELECT ledger_close_time::date AS date,
           APPROX_COUNT_DISTINCT(source_account) AS "activeAddresses",
           COUNT_IF(type='create_account') AS "newAccounts",
           COUNT_IF(type='payment') AS "paymentOps"
    FROM stellar.raw.operations
    WHERE ledger_close_time >= DATEADD(day, -90, CURRENT_DATE())
    GROUP BY 1 ORDER BY 1`,
  dailyFees: `
    SELECT ledger_close_time::date AS date, SUM(fee_charged)/1e7 AS "feesXlm"
    FROM stellar.raw.transactions
    WHERE ledger_close_time >= DATEADD(day, -90, CURRENT_DATE())
    GROUP BY 1 ORDER BY 1`,
  dex: `
    SELECT ledger_close_time::date AS date,
           COUNT(*) AS trades, SUM(usd_amount) AS "usdVolume",
           APPROX_COUNT_DISTINCT(sender_address) AS traders
    FROM stellar.dex.trades
    WHERE ledger_close_time >= DATEADD(day, -90, CURRENT_DATE())
    GROUP BY 1 ORDER BY 1`,
  contracts: `
    SELECT ledger_close_time::date AS date,
           COUNT(*) AS "contractEvents",
           APPROX_COUNT_DISTINCT(contract_id) AS "activeContracts"
    FROM stellar.raw.contract_events
    WHERE ledger_close_time >= DATEADD(day, -90, CURRENT_DATE())
    GROUP BY 1 ORDER BY 1`,
  stablecoins: `
    SELECT token_symbol AS symbol, total_supply_usd AS "supplyUsd"
    FROM stellar.stablecoins.supply_distribution_daily
    WHERE date = (SELECT MAX(date) FROM stellar.stablecoins.supply_distribution_daily)
      AND total_supply_usd > 0
    ORDER BY total_supply_usd DESC NULLS LAST`,
  kpis: `
    SELECT COUNT(*) AS "operationCount",
           APPROX_COUNT_DISTINCT(source_account) AS "activeAddresses",
           COUNT_IF(type='create_account') AS "newAddresses"
    FROM stellar.raw.operations
    WHERE ledger_close_time >= DATEADD(month, -12, CURRENT_DATE())`,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runQuery(sql) {
  const headers = { "X-API-KEY": API_KEY, "Content-Type": "application/json" };
  const submit = await fetch(`${ALLIUM_BASE}/query-runs`, {
    method: "POST", headers, body: JSON.stringify({ sql }),
  });
  if (!submit.ok) throw new Error(`submit ${submit.status}: ${await submit.text()}`);
  const { run_id } = await submit.json();

  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${ALLIUM_BASE}/query-runs/${run_id}/results`, { headers });
    if (r.status === 200) { const j = await r.json(); return j.data ?? j.rows ?? j; }
    if (r.status !== 202) throw new Error(`poll ${r.status}: ${await r.text()}`);
    await sleep(2000);
  }
  throw new Error(`timeout for run ${run_id}`);
}

function mergeByDate(...sets) {
  const m = new Map();
  for (const rows of sets) for (const row of rows) {
    const d = String(row.date).slice(0, 10);
    m.set(d, { ...(m.get(d) || { date: d }), ...row, date: d });
  }
  return [...m.values()].sort((a, b) => a.date.localeCompare(b.date));
}

(async () => {
  console.error("Querying Allium…");
  const [tx, ops, fees, dex, contracts, sc, kpiRows] = await Promise.all(
    [Q.daily, Q.dailyOps, Q.dailyFees, Q.dex, Q.contracts, Q.stablecoins, Q.kpis].map(runQuery)
  );

  const daily = mergeByDate(tx, ops, fees);
  const dexDaily = mergeByDate(dex, contracts);
  const k = kpiRows[0] || {};
  const scSorted = [...sc].sort((a, b) => b.supplyUsd - a.supplyUsd);
  const stablecoinSupplyUsd = scSorted.reduce((s, r) => s + Number(r.supplyUsd || 0), 0);
  const today = new Date().toISOString().slice(0, 10);

  const out = {
    meta: {
      generated: today,
      source: "Allium (stellar.* warehouse)",
      freshnessNote: "Raw tables lag ~5h; today's row is partial.",
      seedNote: ""
    },
    kpis: {
      operationCount:  { label: "Operation Count",       value: Number(k.operationCount || 0),  format: "compact",     sub: "Past 12 months" },
      activeAddresses: { label: "Active Addresses",       value: Number(k.activeAddresses || 0), format: "compact",     sub: "Past 12 months" },
      newAddresses:    { label: "New Addresses",          value: Number(k.newAddresses || 0),    format: "compact",     sub: "Past 12 months" },
      avgFeeUsd:       { label: "Avg Fee per Operation",  value: 0.0003,                          format: "usd4",        sub: "Past 12 months (XLM→USD; set manually or join prices)" },
      stablecoinSupplyUsd: { label: "Stablecoin Supply",  value: stablecoinSupplyUsd,             format: "usdCompact",  sub: "Latest" }
    },
    daily,
    dexDaily,
    stablecoinSupply: scSorted.map(r => ({ symbol: r.symbol, supplyUsd: Number(r.supplyUsd) })),
  };

  await writeFile(OUT, JSON.stringify(out, null, 2) + "\n");
  console.error(`Wrote ${OUT}: ${daily.length} days, ${scSorted.length} stablecoins.`);
})().catch(e => { console.error(e); process.exit(1); });
