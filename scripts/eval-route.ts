import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Job, Mode } from "../src/jobs.ts";
import { ROUTES, THRESHOLDS, classifyWithJev, decideRoute, routeState } from "../src/route.ts";
import type { Route, RouteAnswer } from "../src/route.ts";

type Case = { text: string; label: Route; context?: string; job?: { mode: Mode; state: "done"; pr?: string } };

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
if (!apiKey) {
  console.error("missing TYPESAFE_API_KEY (run with node --env-file=<path to .env> scripts/eval-route.ts)");
  process.exit(2);
}

const cases: Case[] = JSON.parse(await readFile(join(import.meta.dirname, "..", "eval", "route-cases.json"), "utf8"));

function jobOf(c: Case): Job | undefined {
  if (!c.job) return undefined;
  return { mode: c.job.mode, state: { kind: "done", outcome: "succeeded", summary: "", prUrl: c.job.pr } } as Job;
}

async function classify(c: Case): Promise<RouteAnswer | Error> {
  const t0 = Date.now();
  try {
    const answer = await classifyWithJev(apiKey!, routeState(c, jobOf(c)), 20_000);
    latencies.push(Date.now() - t0);
    return answer;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

const latencies: number[] = [];
const results: (RouteAnswer | Error)[] = [];
for (let i = 0; i < cases.length; i += 6) results.push(...(await Promise.all(cases.slice(i, i + 6).map(classify))));

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const fixed = (n: number) => n.toFixed(2);

console.log("\nPer case (label → choice @ confidence):");
cases.forEach((c, i) => {
  const r = results[i];
  const shown = r instanceof Error ? `ERROR ${r.message}` : `${r.choice} @ ${fixed(r.confidence)}${r.choice === c.label ? "" : "   ✗"}`;
  console.log(`  ${pad(c.label, 12)} → ${pad(shown, 26)} ${JSON.stringify(c.text).slice(0, 80)}`);
});

const ok = results.map((r, i) => ({ c: cases[i], r })).filter((x): x is { c: Case; r: RouteAnswer } => !(x.r instanceof Error));
const errors = cases.length - ok.length;
const correct = ok.filter((x) => x.r.choice === x.c.label).length;
console.log(`\nAccuracy: ${correct}/${ok.length} = ${fixed((100 * correct) / ok.length)}%${errors ? ` (${errors} API errors)` : ""}`);
const sorted = [...latencies].sort((a, b) => a - b);
console.log(`Latency: p50 ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted.at(-1)} ms`);

console.log("\nConfusion matrix (rows = label, columns = Jev's choice):");
console.log(`  ${pad("", 12)}${ROUTES.map((r) => pad(r, 12)).join("")}`);
for (const label of ROUTES) {
  const row = ROUTES.map((choice) => ok.filter((x) => x.c.label === label && x.r.choice === choice).length);
  console.log(`  ${pad(label, 12)}${row.map((n) => pad(n || ".", 12)).join("")}`);
}

console.log("\nConfidence by label (mean when right / when wrong):");
for (const label of ROUTES) {
  const rows = ok.filter((x) => x.c.label === label);
  const mean = (xs: typeof rows) => (xs.length ? fixed(xs.reduce((s, x) => s + x.r.confidence, 0) / xs.length) : "-");
  const right = rows.filter((x) => x.r.choice === label);
  const wrong = rows.filter((x) => x.r.choice !== label);
  console.log(`  ${pad(label, 12)} n=${pad(rows.length, 3)} right ${pad(right.length, 3)} @ ${pad(mean(right), 5)} wrong ${pad(wrong.length, 3)} @ ${mean(wrong)}`);
}

function outcome(thresholds: Record<Route, number>) {
  let auto = 0;
  let ask = 0;
  const wrong: string[] = [];
  for (const { c, r } of ok) {
    const d = decideRoute(r, thresholds);
    if (d.kind === "ask") ask++;
    else {
      auto++;
      if (d.route !== c.label) wrong.push(`${c.label}→${d.route} @ ${fixed(r.confidence)} ${JSON.stringify(c.text).slice(0, 50)}`);
    }
  }
  return { auto, ask, wrong };
}

console.log("\nThreshold sweep (read-only = question/investigate/review; high = change/plan/none):");
console.log(`  ${pad("read-only", 10)}${pad("high", 6)}${pad("auto", 6)}${pad("ask", 6)}${pad("wrong", 7)}wrong into change`);
for (const ro of [0.3, 0.4, 0.5, 0.6, 0.7]) {
  for (const hi of [0.6, 0.7, 0.8, 0.9]) {
    const t: Record<Route, number> = { question: ro, investigate: ro, review: ro, change: hi, plan: hi, none: hi };
    const o = outcome(t);
    console.log(`  ${pad(ro, 10)}${pad(hi, 6)}${pad(o.auto, 6)}${pad(o.ask, 6)}${pad(o.wrong.length, 7)}${o.wrong.filter((w) => w.includes("→change")).length}`);
  }
}

const chosen = outcome(THRESHOLDS);
console.log(`\nChosen thresholds ${JSON.stringify(THRESHOLDS)}:`);
console.log(`  auto-routed ${chosen.auto}/${ok.length}, asked ${chosen.ask}/${ok.length}, wrong auto-routes ${chosen.wrong.length}, wrong into change ${chosen.wrong.filter((w) => w.includes("→change")).length}`);
for (const w of chosen.wrong) console.log(`  ✗ ${w}`);
