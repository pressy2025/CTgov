#!/usr/bin/env node
//
// Verification harness for the registry layer in clinicaltrials-api-playground.html.
//
//   node tools/verify-registry.mjs           # units + live resolution + render checks
//   node tools/verify-registry.mjs --e2e     # also runs a full CT.gov -> openFDA pass
//
// No dependencies, no package.json, no build step — it reads the playground HTML and evaluates
// the shipped <script> directly, so it can never drift from the code it claims to test. Nothing
// here is served to users; render.yaml publishes the repo root but these files are unlinked.
//
// It exists because two silent bugs reached a working build during development and only a live
// run exposed them:
//   · `HANGZHOU*` matched HANGZHOU BINJIANG — a different company sharing a city name.
//   · The demotion rule was inverted: it demoted BioNTech (raising its score for a CDMO seller)
//     while sparing the thin-portfolio case it was written for.
// Both are now assertions below. Neither produced an error at runtime — that is the point.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "clinicaltrials-api-playground.html"), "utf8");
const E2E = process.argv.includes("--e2e");

// ── Load the playground script with a DOM stub (it wires handlers at parse time) ──
const js = src.match(/<script>([\s\S]*?)<\/script>/g)
  .map(s => s.slice(8, -9))
  .sort((a, b) => b.length - a.length)[0];

const el = () => new Proxy(function () {}, {
  get: (t, k) => k === "value" ? "" : k === "style" ? {}
      : k === "classList" ? { add() {}, remove() {}, contains: () => false }
      : k === "dataset" ? {} : el(),
  set: () => true, apply: () => el(),
});
globalThis.document = { getElementById: () => el(), querySelector: () => el(),
                        querySelectorAll: () => [], createElement: () => el(), addEventListener() {} };
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.Chart = function () {};

const M = await import("data:text/javascript," + encodeURIComponent(js + `
export { lfExtract, lfBuildQueries, lfExecuteAll, lfRollupSponsors, lfScoreSponsor,
         lfRegCore, lfRegProbeGuard, lfRegVariants, lfRegAccept, lfFdaResolve, lfRegDerive,
         lfPool, lfSizeTier, lfSizeTierFromTrials, lfRenderResults, lfAiPayload,
         LF_EXAMPLES, LF_SIZE_TIERS };`));

let fail = 0;
const ok = (c, m) => { console.log((c ? "  \x1b[32m✓\x1b[0m " : "  \x1b[31m✗\x1b[0m ") + m); if (!c) fail++; };
const head = t => console.log(`\n\x1b[1m${t}\x1b[0m`);

// ─────────────────────────────────────────────────────────────────────────────
head("Probe shape — the failure that produces a wrong answer with no error");
// sponsor_name:JANSSEN BIOTECH (unquoted, multi-token) returns VERO BIOTECH INC.
const NAMES = ["Janssen Research & Development, LLC", "OnCusp Therapeutics, Inc.", "AstraZeneca",
  "Shanghai Henlius Biotech", "RemeGen Co., Ltd.", "Akeso", "BioNTech SE", "Daiichi Sankyo",
  "MSD", "Bio Inc.", "TORL Biotherapeutics, LLC", "EMD Serono Research & Development Institute, Inc.",
  "Moderna, Inc.", "Ionis Pharmaceuticals", "Arcus Biosciences, Inc.", "Novartis Pharmaceuticals",
  "Hoffmann-La Roche", "Chia Tai Tianqing Pharmaceutical Group", "3M Company", "Zai Lab",
  "Merck Sharp & Dohme LLC", "GSK", "Immunovant", "Blueprint Medicines", "F. Hoffmann-La Roche AG",
  "Hangzhou Zhongmei Huadong Pharmaceutical Co., Ltd."];
const bad = [];
for (const n of NAMES) for (const p of M.lfRegVariants(n)) {
  const v = p.value;
  if (!((v.startsWith('"') && v.endsWith('"')) || /^[A-Z0-9]+\*$/.test(v))) bad.push(`${n} -> ${v}`);
}
ok(bad.length === 0, `all probes over ${NAMES.length} names are quoted phrases or single-token wildcards`
  + (bad.length ? "\n      OFFENDERS: " + bad.join("\n      ") : ""));

head("Guards — what makes `absent` trustworthy");
ok(!M.lfRegProbeGuard("BIO"), "BIO blocked (12 name families / 173 apps)");
ok(!M.lfRegProbeGuard("MSD"), "MSD blocked (under 4 chars)");
ok(!M.lfRegProbeGuard("HANGZHOU"), "HANGZHOU blocked (place name, not a company)");
ok(M.lfRegProbeGuard("JANSSEN") && M.lfRegProbeGuard("ASTRAZENECA"), "distinctive roots allowed");

head("Similarity guard");
const core = M.lfRegCore;
ok(M.lfRegAccept(core("Janssen Biotech"), "JANSSEN PHARMS"), "JANSSEN ~ JANSSEN PHARMS");
ok(!M.lfRegAccept(core("Janssen Biotech"), "VERO BIOTECH INC"), "JANSSEN !~ VERO BIOTECH INC");
ok(M.lfRegAccept(core("Ionis Pharmaceuticals"), "IONIS PHARMS INC"), "IONIS ~ IONIS PHARMS INC");
ok(!M.lfRegAccept(core("Novartis"), "NOVAST LABS"), "NOVARTIS !~ NOVAST LABS");
ok(!M.lfRegAccept(core("Hangzhou Zhongmei Huadong"), "HANGZHOU BINJIANG"),
   "HANGZHOU ZHONGMEI !~ HANGZHOU BINJIANG (shared city is not shared ownership)");

head("Stem rung — floored at 9 chars so verified true zeros survive");
const stems = n => M.lfRegVariants(n).filter(p => p.rung === "P3").map(p => p.value);
ok(stems("Immunovant")[0] === "IMMUNOV*", "IMMUNOVANT (10) gets a stem rung");
ok(stems("BioNTech SE").length === 0, "BIONTECH (8) does not");
ok(stems("Moderna, Inc.").length === 0, "MODERNA (7) does not");

head("Size tier — additivity, then asymmetry");
const sp = o => Object.assign({ trialCount: 1, phases: new Set(), countries: new Set(), reg: null }, o);
const withReg = (o, ev) => Object.assign(sp(o), { reg: { derived: { sizeEvidence: ev } } });
const drift = [];
for (const f of [sp({ trialCount: 1 }), sp({ trialCount: 6 }), sp({ trialCount: 20 }),
                 sp({ trialCount: 2, phases: new Set(["PHASE3"]) }), sp({ trialCount: 13 }),
                 sp({ trialCount: 4, phases: new Set(["PHASE4"]) }),
                 sp({ trialCount: 6, countries: new Set(Array.from({ length: 25 }, (_, i) => "C" + i)) })]) {
  if (M.lfSizeTier(f) !== M.lfSizeTierFromTrials(f)) drift.push(`trials=${f.trialCount}`);
}
ok(drift.length === 0, "R0: with reg=null every fixture yields its pre-feature tier" + (drift.length ? " :: " + drift : ""));
ok(M.lfSizeTier(withReg({ trialCount: 2 }, "large_commercial")) === "large", "promote — Daiichi/Janssen case");
ok(M.lfSizeTier(withReg({ trialCount: 1 }, "commercial_stage")) === "mid", "promote — emerging + marketed product");
ok(M.lfSizeTier(withReg({ trialCount: 2, phases: new Set(["PHASE3"]) }, "clinical_stage")) === "emerging",
   "demote — thin portfolio + one late-phase trial (Mirati/Immunovant)");
ok(M.lfSizeTier(withReg({ trialCount: 7 }, "clinical_stage")) === "mid",
   "NO demote on volume — BioNTech (7 trials + genuine FDA zero) holds mid");
ok(M.lfSizeTier(withReg({ trialCount: 20 }, "clinical_stage")) === "large", "never demote from large");
ok(M.lfSizeTier(withReg({ trialCount: 2 }, "unknown")) === "emerging", "unknown evidence is inert");

// ─────────────────────────────────────────────────────────────────────────────
head("Live openFDA resolution");
const LIVE = ["Janssen Research & Development, LLC", "AstraZeneca", "BioNTech SE", "Moderna, Inc.",
  "Akeso", "OnCusp Therapeutics, Inc.", "MSD", "Daiichi Sankyo",
  "EMD Serono Research & Development Institute, Inc.", "Hangzhou Zhongmei Huadong Pharmaceutical Co., Ltd."];
const live = await M.lfPool(LIVE, 4, async n => ({ n, fda: await M.lfFdaResolve(n) }));
console.log("");
for (const { n, fda } of live) {
  console.log(`   ${n.slice(0, 34).padEnd(36)} ${fda.resolution.padEnd(11)} apps=${String(fda.appCount).padEnd(5)} `
    + `probes: ${fda.probes.map(p => p.value + "=" + (p.total ?? "err")).join(" ")}`);
}
console.log("");
const G = k => live.find(r => r.n.startsWith(k)).fda;
ok(G("Janssen").resolution === "matched" && G("Janssen").appCount >= 90, `Janssen -> ${G("Janssen").appCount} apps`);
ok(G("AstraZeneca").appCount >= 100, `AstraZeneca -> ${G("AstraZeneca").appCount} apps`);
ok(G("EMD Serono").resolution === "matched", "multi-token alias resolves via quoted phrase");
ok(G("MSD").resolution !== "absent", `MSD never 'absent' -> ${G("MSD").resolution}`);
ok(G("Moderna").resolution === "unresolved", "Moderna: NDC cross-check prevents a false zero");
ok(G("OnCusp").resolution === "absent", "OnCusp -> absent (genuinely clinical-stage)");
ok(G("Hangzhou").resolution !== "matched", `Hangzhou not falsely matched -> ${G("Hangzhou").resolution}`);

// ─────────────────────────────────────────────────────────────────────────────
if (E2E) {
  head("End-to-end — BIOVECTRA positioning through CT.gov and openFDA");
  const attrs = M.lfExtract(M.LF_EXAMPLES.biovectra);
  const queries = M.lfBuildQueries(attrs);
  const runs = await M.lfExecuteAll(queries);
  ok(runs.every(r => r.ok), `all ${runs.length} CT.gov queries succeeded`);

  const rank = reg => M.lfRollupSponsors(runs, reg).sponsors
    .map(s => ({ sponsor: s, score: M.lfScoreSponsor(s, attrs, queries.length) }))
    .sort((a, b) => b.score.total - a.score.total
      || String(b.sponsor.newestLastUpdate || "").localeCompare(String(a.sponsor.newestLastUpdate || ""))
      || b.sponsor.trialCount - a.sponsor.trialCount);

  const before = rank(null);
  const reg = new Map();
  await M.lfPool(before.slice(0, 20).map(s => s.sponsor), 4, async s => {
    const e = { v: 1, fetchedAt: new Date().toISOString(), sources: ["openfda"], fda: await M.lfFdaResolve(s.sponsorName) };
    e.derived = M.lfRegDerive(e);
    reg.set(s.sponsorNorm, e);
  });
  const after = rank(reg);

  console.log("");
  let moved = 0;
  for (const b of before.slice(0, 20)) {
    const a = after.find(x => x.sponsor.sponsorName === b.sponsor.sponsorName);
    const s = a.sponsor, f = s.reg && s.reg.fda;
    const t = s.sizeTierSource !== "trials"
      ? `\x1b[35m${M.LF_SIZE_TIERS[s.sizeTierBase].label}→${M.LF_SIZE_TIERS[s.sizeTier].label}\x1b[0m` : M.LF_SIZE_TIERS[s.sizeTier].label;
    if (s.sizeTierSource !== "trials") moved++;
    const sc = a.score.total !== b.score.total ? `\x1b[35m${b.score.total}→${a.score.total}\x1b[0m` : String(b.score.total);
    console.log(`   ${b.sponsor.sponsorName.slice(0, 32).padEnd(34)}${t.padEnd(t.includes("\x1b") ? 27 : 18)}${sc.padEnd(sc.includes("\x1b") ? 18 : 8)}`
      + (!f ? "" : f.resolution === "matched" ? `${f.appCount} apps` : f.resolution));
  }
  console.log(`\n   ${moved} of 20 size tiers corrected\n`);

  ok(before.slice(0, 20).every(b => b.sponsor.sizeTier === b.sponsor.sizeTierBase),
     "R0: the unverified rollup never moves a tier");
  ok(after.slice(0, 20).every(s => {
    const f = s.sponsor.reg && s.sponsor.reg.fda;
    return !f || !["unresolved", "error", "ambiguous", "skipped"].includes(f.resolution) || s.sponsor.sizeTierSource === "trials";
  }), "unresolved / ambiguous never moved a tier");
  ok(!after.slice(0, 20).some(s => {
    const f = s.sponsor.reg && s.sponsor.reg.fda;
    return f && f.resolution === "absent" && s.sponsor.sizeTierBase === "large";
  }), "no large-footprint sponsor demoted on an FDA zero");

  head("Render");
  const plain = M.lfRenderResults(runs, attrs, queries, null);
  const rich = M.lfRenderResults(runs, attrs, queries, reg);
  for (const [label, html] of [["unverified", plain], ["verified", rich]]) {
    ok(!/undefined|\[object Object\]|NaN/.test(html), `${label} render has no undefined / NaN / [object Object]`);
    const o = (html.match(/<div/g) || []).length, c = (html.match(/<\/div>/g) || []).length;
    ok(o === c, `${label} div tags balanced (${o}/${c})`);
  }
  ok(plain.includes("Not verified"), "unverified cards say 'Not verified', never 0");
  ok(!/FDA · 0 apps/.test(rich), "no card ever renders 'FDA · 0 apps'");
  ok(rich.includes("Regulatory evidence"), "verified cards expose the evidence disclosure");

  const payload = M.lfAiPayload(after, attrs);
  ok(payload.enrichment.ran === true, "AI payload declares enrichment coverage");
  ok(payload.sponsors.every(s => !s.reg || s.reg.fdaStatus), "every reg block carries an explicit fdaStatus");
  ok(payload.sponsors.every(s => !s.reg || s.reg.fdaStatus === "matched" || s.reg.fdaApps === undefined),
     "no application count is sent for a non-matched sponsor");
}

console.log(fail ? `\n\x1b[31m${fail} failure(s)\x1b[0m\n` : `\n\x1b[32mAll checks passed.\x1b[0m${E2E ? "" : "  (run with --e2e for the full pass)"}\n`);
process.exit(fail ? 1 : 0);
