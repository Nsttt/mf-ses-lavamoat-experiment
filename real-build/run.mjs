// Runs every real-build scenario, each in its own fresh Node process, prints
// tables and saves results/real-build-<timestamp>.json.
//
//   node real-build/run.mjs [--quick] [--repeats 1]
//
// Build first: node real-build/build.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    quick: { type: "boolean", default: false },
    repeats: { type: "string", default: "1" },
  },
});
const repeats = Number(values.repeats);
const scale = (n) => (values.quick ? Math.max(5, Math.round(n / 5)) : n);

if (!existsSync(new URL("./dist/host-contained/server.js", import.meta.url))) {
  console.error("Build first: node real-build/build.mjs");
  process.exit(1);
}

const VARIANTS = ["mf-node", "mf-node-patched", "contained"];
const GROUPS = [
  {
    title: "Well-behaved remote, repeated deploys",
    scenarios: VARIANTS.map((variant) => ({ variant, deploys: scale(100) })),
  },
  {
    title: "Remote that leaves something attached to the host",
    scenarios: ["setInterval", "globalCache", "processOn"].flatMap((behaviour) =>
      VARIANTS.map((variant) => ({ variant, behaviour, deploys: scale(40) })),
    ),
  },
  {
    title: "Request in flight while a new version is deployed",
    scenarios: VARIANTS.map((variant) => ({ variant, deploys: scale(20), inFlight: true })),
  },
  {
    title: "1,000 deploys in a 48 MiB heap",
    scenarios: VARIANTS.map((variant) => ({
      variant,
      deploys: scale(1000),
      nodeFlags: ["--max-old-space-size=48"],
    })),
  },
];

const scenarioFile = fileURLToPath(new URL("./scenario.mjs", import.meta.url));
const report = { date: new Date().toISOString(), node: process.version, groups: [] };

for (const group of GROUPS) {
  const rows = [];
  for (const { nodeFlags = [], ...scenario } of group.scenarios) {
    for (let run = 1; run <= repeats; run += 1) {
      const started = Date.now();
      const child = spawnSync(
        process.execPath,
        ["--expose-gc", "--no-warnings", ...nodeFlags, scenarioFile, JSON.stringify(scenario)],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      const line = child.stdout.split("\n").find((l) => l.startsWith("RESULT "));
      const row = line
        ? JSON.parse(line.slice("RESULT ".length))
        : {
            ...scenario,
            crashed: /heap out of memory/.test(child.stderr) ? "out of memory" : `exit ${child.status}`,
          };
      rows.push({ ...row, run, seconds: Math.round((Date.now() - started) / 1000) });
      process.stderr.write(`done ${group.title}: ${scenario.variant} ${scenario.behaviour ?? ""}\n`);
    }
  }
  report.groups.push({ title: group.title, rows });
  console.log(`\n${group.title}`);
  console.table(
    rows.map((r) => ({
      variant: r.variant,
      ...(r.behaviour && r.behaviour !== "clean" ? { remote: r.behaviour } : {}),
      deploys: r.inFlight ? `${r.deploys} rounds` : r.deploys,
      ...(r.crashed
        ? { result: `CRASHED: ${r.crashed}` }
        : {
            "versions alive": r.versionsAlive,
            "retained MiB": r.retainedGrowthMiB,
            "MiB incl. V8 code cache": r.heapGrowthMiB,
            ...(r.inFlight
              ? { "wrong responses": r.inFlightWrong }
              : { "stale deploys": r.staleDeploys, "deploy→fresh ms": r.medianDeployToFreshMs }),
            errors: r.errors,
          }),
    })),
  );
}

// Read package.json directly: some packages do not export it.
const version = (name) =>
  JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8")).version;
report.packages = Object.fromEntries(
  ["@module-federation/enhanced", "@module-federation/runtime", "@rspack/core", "lavamoat-core", "ses"].map(
    (name) => {
      try {
        return [name, version(name)];
      } catch {
        return [name, "unknown"];
      }
    },
  ),
);
mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
const out = new URL(`../results/real-build-${report.date.replaceAll(":", "-")}.json`, import.meta.url);
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nSaved ${fileURLToPath(out)}`);
