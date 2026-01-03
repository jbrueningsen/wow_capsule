#!/usr/bin/env node
/**
 * fetch_wcl_data.js
 *
 * Generates data.json for the Return of the Alliance "capsule" page using the Warcraft Logs v2 GraphQL API.
 *
 * SECURITY NOTE:
 * - DO NOT put your client secret in the HTML or commit it to GitHub.
 * - Use environment variables when running this script locally.
 *
 * Usage:
 *   WCL_BASE=https://fresh.warcraftlogs.com \
 *   WCL_CLIENT_ID=... \
 *   WCL_CLIENT_SECRET=... \
 *   node fetch_wcl_data.js
 *
 * Optional:
 *   REPORTS=XdBJty6RqnCV2xwc,xtNDpvjJ7k6wz1PX
 */

const fs = require("fs");

const BASE = process.env.WCL_BASE || "https://fresh.warcraftlogs.com";
const CLIENT_ID = process.env.WCL_CLIENT_ID;
const CLIENT_SECRET = process.env.WCL_CLIENT_SECRET;
const REPORTS = (process.env.REPORTS || "XdBJty6RqnCV2xwc,xtNDpvjJ7k6wz1PX")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing WCL_CLIENT_ID or WCL_CLIENT_SECRET env vars.");
  process.exit(1);
}

async function getToken() {
  // Client Credentials flow: POST {base}/oauth/token
  const body = new URLSearchParams({ grant_type: "client_credentials" }).toString();
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

  const res = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Token request failed (${res.status}): ${txt}`);
  }
  const json = await res.json();
  return json.access_token;
}

async function gql(token, query, variables) {
  const res = await fetch(`${BASE}/api/v2/client`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (json.errors) {
    throw new Error(JSON.stringify(json.errors, null, 2));
  }
  return json.data;
}

const Q_REPORT_FIGHTS = `
query($code:String!){
  reportData{
    report(code:$code){
      code
      title
      startTime
      endTime
      fights(killType:Encounters){
        id
        name
        startTime
        endTime
        kill
      }
    }
  }
}`;

// NOTE: "table" is commonly used for damage/healing summaries.
// The exact response shape can vary by game/version; we treat it as a JSON blob.
const Q_TABLE = `
query($code:String!, $start:Float!, $end:Float!, $dataType:TableDataType!){
  reportData{
    report(code:$code){
      table(dataType:$dataType, startTime:$start, endTime:$end, viewBy:Source)
    }
  }
}`;

// Try a couple likely enum names to maximize chance of working for Classic.
// We will attempt these in order.
const TABLE_TYPES = {
  damage: ["DamageDone", "Damage"],
  healing: ["Healing", "HealingDone"],
};

function pickEntries(tableObj) {
  // Warcraft Logs tables usually return something like: { data: { entries: [...] } } or { entries: [...] }
  if (!tableObj) return [];
  if (Array.isArray(tableObj.entries)) return tableObj.entries;
  if (tableObj.data && Array.isArray(tableObj.data.entries)) return tableObj.data.entries;
  if (Array.isArray(tableObj.data)) return tableObj.data;
  return [];
}

function entryName(e) {
  return e.name || (e.actor && e.actor.name) || (e.guid && String(e.guid)) || "Unknown";
}
function entryTotal(e) {
  return e.total ?? e.amount ?? e.damage ?? e.healing ?? 0;
}

async function fetchTableWithFallback(token, code, start, end, kind) {
  const candidates = TABLE_TYPES[kind];
  let lastErr = null;
  for (const dataType of candidates) {
    try {
      const data = await gql(token, Q_TABLE, { code, start, end, dataType });
      return { dataTypeUsed: dataType, table: data.reportData.report.table };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

(async function main(){
  const token = await getToken();

  const out = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    reports: [],
    fights: [],
    overall: { players: [] },
  };

  const totals = new Map(); // name -> {damage, healing}

  for (const code of REPORTS) {
    const rep = await gql(token, Q_REPORT_FIGHTS, { code });
    const report = rep.reportData.report;
    if (!report) continue;

    out.reports.push({ code: report.code, title: report.title });

    // Only boss encounters, and only those with a non-zero duration
    const fights = (report.fights || []).filter(f => (f.endTime - f.startTime) > 0);

    for (const f of fights) {
      const start = f.startTime;
      const end = f.endTime;

      // Pull damage + healing tables for this fight time range.
      // Some reports want relative times; fights are already relative to report start in many APIs.
      let damageTable = null, healingTable = null;

      try {
        damageTable = await fetchTableWithFallback(token, code, start, end, "damage");
      } catch (e) {
        // If table is unsupported, we keep going.
        damageTable = { table: null, error: String(e) };
      }

      try {
        healingTable = await fetchTableWithFallback(token, code, start, end, "healing");
      } catch (e) {
        healingTable = { table: null, error: String(e) };
      }

      const dmgEntries = pickEntries(damageTable.table);
      const healEntries = pickEntries(healingTable.table);

      // Top 3 snapshots
      const topDamage = dmgEntries
        .map(e => ({ name: entryName(e), total: entryTotal(e) }))
        .sort((a,b)=>b.total-a.total)
        .slice(0,3);

      const topHealing = healEntries
        .map(e => ({ name: entryName(e), total: entryTotal(e) }))
        .sort((a,b)=>b.total-a.total)
        .slice(0,3);

      // Aggregate totals
      for (const e of dmgEntries) {
        const name = entryName(e);
        const total = entryTotal(e);
        const cur = totals.get(name) || { damage: 0, healing: 0 };
        cur.damage += total;
        totals.set(name, cur);
      }
      for (const e of healEntries) {
        const name = entryName(e);
        const total = entryTotal(e);
        const cur = totals.get(name) || { damage: 0, healing: 0 };
        cur.healing += total;
        totals.set(name, cur);
      }

      out.fights.push({
        reportCode: code,
        boss: f.name,
        kill: !!f.kill,
        startTime: start,
        endTime: end,
        topDamage,
        topHealing,
        meta: {
          damageDataType: damageTable.dataTypeUsed || null,
          healingDataType: healingTable.dataTypeUsed || null,
        }
      });
    }
  }

  out.overall.players = [...totals.entries()]
    .map(([name, v]) => ({ name, damage: Math.round(v.damage), healing: Math.round(v.healing) }))
    .sort((a,b)=> (b.damage + b.healing) - (a.damage + a.healing));

  fs.writeFileSync("data.json", JSON.stringify(out, null, 2));
  console.log("Wrote data.json with", out.reports.length, "reports and", out.fights.length, "fights.");
})().catch(err => {
  console.error(err);
  process.exit(1);
});
