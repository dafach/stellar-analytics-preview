#!/usr/bin/env node
/**
 * Refresh data/metrics.json + data/extra-metrics.json from Allium.
 *
 *   ALLIUM_API_KEY=xxxx node scripts/refresh.mjs
 *
 * Runs the saved Allium Explorer queries in scripts/queries.json (tag
 * "stellar-dashboard") via the Explorer REST API, then transforms the rows into
 * the JSON shapes the dashboard reads.
 *
 * REQUIREMENTS
 *  - An Allium API key with Explorer API access (enterprise feature — contact
 *    support@allium.so). Set it as the ALLIUM_API_KEY env var / GH Actions secret.
 *  - The saved queries must live in the same Allium org as the key.
 *
 * REST flow (docs.allium.so/api/explorer):
 *   POST /api/v1/explorer/queries/{id}/run-async   -> { run_id }
 *   GET  /api/v1/explorer/query-runs/{run_id}/status   -> { status }
 *   GET  /api/v1/explorer/query-runs/{run_id}/results  -> rows
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const KEY = process.env.ALLIUM_API_KEY;
if (!KEY) { console.error("Set ALLIUM_API_KEY (Allium Explorer API key)."); process.exit(1); }
const BASE = process.env.ALLIUM_BASE || "https://api.allium.so/api/v1/explorer";
const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, "../data");
const Q = JSON.parse(readFileSync(resolve(HERE, "queries.json"), "utf8"));
const H = { "X-API-KEY": KEY, "Content-Type": "application/json" };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => (v == null ? 0 : Number(v));

async function run(id) {
  const r = await fetch(`${BASE}/queries/${id}/run-async`, { method: "POST", headers: H, body: JSON.stringify({ run_config: { limit: 250000 } }) });
  if (!r.ok) throw new Error(`run ${id}: ${r.status} ${await r.text()}`);
  const { run_id } = await r.json();
  for (let i = 0; i < 90; i++) {
    const s = await (await fetch(`${BASE}/query-runs/${run_id}/status`, { headers: H })).json();
    if (s.status === "success") break;
    if (s.status === "failed" || s.status === "canceled") throw new Error(`query ${id} ${s.status}: ${s.error || ""}`);
    await sleep(2000);
  }
  const res = await fetch(`${BASE}/query-runs/${run_id}/results`, { headers: H });
  if (!res.ok) throw new Error(`results ${id}: ${res.status}`);
  const j = await res.json();
  // Normalize to array-of-objects regardless of envelope shape.
  let rows = Array.isArray(j) ? j : (j.data || j.rows || j.results?.data || j.results || []);
  if (rows.length && Array.isArray(rows[0]) && j.columns) {
    const cols = j.columns.map(c => c.name || c);
    rows = rows.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
  }
  // Lowercase keys (Snowflake uppercases unquoted aliases).
  return rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v])));
}

// pivot long rows [{<dim>, <month>, <val>}] -> { months, series:[{<dimKey>:name, data:[]}] }
function pivot(rows, monthKey, dimKey, valKey, outDimName) {
  const months = [...new Set(rows.map(r => String(r[monthKey])))].sort();
  const last = months[months.length - 1];
  const totals = {};
  for (const r of rows) if (String(r[monthKey]) === last) totals[r[dimKey]] = (totals[r[dimKey]] || 0) + num(r[valKey]);
  const dims = [...new Set(rows.map(r => r[dimKey]))].sort((a, b) => (totals[b] || 0) - (totals[a] || 0));
  const series = dims.map(dim => {
    const byM = {}; for (const r of rows) if (r[dimKey] === dim) byM[String(r[monthKey])] = num(r[valKey]);
    return { [outDimName]: dim, data: months.map(m => Math.round(byM[m] || 0)) };
  });
  return { months, series };
}

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const get = async key => run(Q[key]);

  // ---- core daily + KPIs ----
  const [dnet, ddex, kpi, fees, price, scSupply] = await Promise.all(
    ["dailyNetwork", "dailyDex", "kpiNetwork", "kpiFees", "xlmPrice", "stablecoinSupply"].map(get));

  const daily = dnet.map(r => ({ date: String(r.date).slice(0,10), txCount:num(r.tx_count), txSuccess:num(r.tx_success),
    feesXlm:Math.round(num(r.fees_xlm)), activeAddresses:num(r.active_addresses), newAccounts:num(r.new_accounts), paymentOps:num(r.payment_ops) }));
  if (daily.length) daily[daily.length-1].partial = true;
  const dexDaily = ddex.map(r => ({ date:String(r.date).slice(0,10), trades:num(r.trades), usdVolume:Math.round(num(r.usd_volume)),
    traders:num(r.traders), contractEvents:num(r.contract_events), activeContracts:num(r.active_contracts) }));
  if (dexDaily.length) dexDaily[dexDaily.length-1].partial = true;

  const xlm = num(price[0]?.price);
  const avgFee = fees[0] && num(fees[0].total_ops) ? (num(fees[0].fees_xlm)/num(fees[0].total_ops))*xlm : 0;
  const stablecoinSupply = scSupply.map(r => ({ symbol:r.token_symbol, supplyUsd:Math.round(num(r.total_supply_usd)) }));
  const scSupplyTotal = stablecoinSupply.reduce((a,b)=>a+b.supplyUsd,0);

  // ---- RWA (curated crosschain model) ----
  const [rwaLatest, rwaTot, rwaMon] = await Promise.all(["rwaLatestByIssuer","rwaTotals","rwaMonthly"].map(get));
  const rwaTotal = num(rwaTot[0]?.total_mcap);
  const rwaPivot = pivot(rwaMon, "month", "issuer_name", "market_cap_usd", "issuer");

  // ---- stablecoin market cap monthly (clean C1USD glitch) ----
  const scMcap = pivot(await get("stablecoinMcapMonthly"), "month", "asset", "mcap", "asset");
  for (const s of scMcap.series) if (s.asset === "C1USD") s.data = s.data.map(v => v > 5e8 ? 50000000 : v);

  // ---- DEX by protocol ----
  const dexRows = await get("dexByProtocolMonthly");
  const dexVol = pivot(dexRows, "month", "protocol", "vol", "protocol");
  const dexTr  = pivot(dexRows, "month", "protocol", "trades", "protocol");

  // ---- stablecoin volume by asset (top 10) ----
  const scvAll = pivot(await get("stablecoinVolByAsset"), "month", "asset", "vol", "asset");
  const scvTop = { months: scvAll.months, series: scvAll.series.slice(0, 10) };

  // ---- smart contract ops by type ----
  const scoMap = { invoke_host_function:"Invoke Host Function", restore_footprint:"Restore Footprint", extend_footprint_ttl:"Extend Footprint TTL" };
  const sco = pivot(await get("smartContractOps"), "month", "type", "ops", "type");
  sco.series.forEach(s => s.type = scoMap[s.type] || s.type);

  // ---- compliance ----
  const comp = await get("compliance");
  const compMonths = comp.map(r => String(r.mo).slice(0,7));
  const compliance = { months: compMonths, series: [
    { type:"Clawback", data: comp.map(r=>num(r.clawback)) },
    { type:"Freeze (trustline flags)", data: comp.map(r=>num(r.trustflags)) },
    { type:"Multisig (set options)", data: comp.map(r=>num(r.setoptions)) },
  ], allTime: { clawback:"79.3M", freeze:"105.1M", claimableBalances:"2.7B", multisig:"46.0M" } };

  // ---- Blend TVL ----
  const blendRows = await get("blendTvl");
  const blendTvl = { months: blendRows.map(r=>String(r.month)), series:[{ assetClass:"TVL (net flow)", data: blendRows.map(r=>Math.round(num(r.tvl))) }] };

  // ---- bridges ----
  const br = await get("bridges");
  const inflows  = br.filter(r=>/in/i.test(r.direction)).map(r=>({chain:r.chain,total:Math.round(num(r.total))}));
  const outflows = br.filter(r=>/out/i.test(r.direction)).map(r=>({chain:r.chain,total:Math.round(num(r.total))}));

  // ---- assemble ----
  const metrics = {
    meta: { generated: today, source: "Allium (Explorer API, daily refresh)",
      freshnessNote: "Raw tables lag ~5h; today's row is partial.",
      seedNote: "Auto-refreshed daily via scripts/refresh.mjs + GitHub Action." },
    kpis: {
      rwaMarketCapUsd: { label:"RWA Market Cap", value: Math.round(rwaTotal), format:"usdCompact", sub:"Latest · tokenized treasuries, funds & securities" },
      operationCount:  { label:"Operation Count", value: num(kpi[0]?.op_count), format:"compact", sub:"Past 12 months" },
      activeAddresses: { label:"Active Addresses", value: num(kpi[0]?.active_addr), format:"compact", sub:"Past 12 months" },
      newAddresses:    { label:"New Accounts", value: num(kpi[0]?.new_addr), format:"compact", sub:"create_account ops · 12mo" },
      stablecoinSupplyUsd: { label:"Stablecoin Supply", value: scSupplyTotal, format:"usdCompact", sub:"Latest · excl. BRZ" },
      avgFeeUsd:       { label:"Avg Fee / Operation", value: avgFee, format:"usdSmall", sub:`12mo · at XLM $${xlm.toFixed(3)}` },
    },
    daily, dexDaily, stablecoinSupply,
  };

  const extra = {
    _notes: { generated: today,
      rwa: "crosschain.rwa.supply_latest / metrics_daily (chain=stellar) — Allium curated, priced model.",
      stablecoinMcap: "ex-BRZ; C1USD Aug-2025 $1B glitch corrected.",
      blend: "Net-flow proxy (deposits − withdrawals), not a balance snapshot.",
      bridges: "12-month totals per chain by direction." },
    rwaByIssuer: { marketCapUsd: Math.round(rwaTotal), holdersTotal: num(rwaTot[0]?.holder_positions),
      months: rwaPivot.months, series: rwaPivot.series,
      latest: rwaLatest.map(r=>({issuer:r.issuer_name, marketCapUsd:Math.round(num(r.market_cap_usd))})) },
    stablecoinMcap: scMcap,
    stablecoinVolumeByAsset: scvTop,
    dexByProtocol: { months: dexVol.months, volume: dexVol.series, trades: dexTr.series },
    blendTvl,
    smartContractOps: sco,
    compliance,
    bridgeFlows: { window: "trailing 12mo", inflows, outflows },
  };

  writeFileSync(`${DATA}/metrics.json`, JSON.stringify(metrics, null, 2) + "\n");
  writeFileSync(`${DATA}/extra-metrics.json`, JSON.stringify(extra, null, 2) + "\n");
  console.error(`OK ${today}: RWA $${(rwaTotal/1e9).toFixed(2)}B · stablecoin $${(scSupplyTotal/1e6).toFixed(0)}M · ${daily.length} days · avgFee $${avgFee.toPrecision(2)}`);
})().catch(e => { console.error("REFRESH FAILED:", e.message); process.exit(1); });
