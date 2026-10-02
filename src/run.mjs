// Runs every scenario in its own fresh Node process and prints a table.
//
//   node src/run.mjs [--versions 100] [--repeats 1] [--only ses-all]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const { values } = parseArgs({
  options: {
    versions: { type: "string", default: "100" },
    repeats: { type: "string", default: "1" },
    only: { type: "string" },
  },
});
const versions = Number(values.versions);
const repeats = Number(values.repeats);

// What a remote is allowed to see in the "policy" loader, LavaMoat-style.
const POLICY = { setTimeout: true, clearTimeout: true, fetch: true, console: true };

const SCENARIOS = [
  // Baseline: what @module-federation/node does today, no containment.
  { loader: "vm", behaviour: "clean" },
  // A compartment with nothing from the host.
  { loader: "ses-none", behaviour: "clean" },
  // lavamoat-core copyWrappedGlobals: the remote can use every host global.
  { loader: "ses-all", behaviour: "clean" },
  { loader: "ses-all", behaviour: "setInterval" },
  { loader: "ses-all", behaviour: "processOn" },
  { loader: "ses-all", behaviour: "exportsHostFn" },
  { loader: "ses-all", behaviour: "overwriteHostGlobal" },
  // lavamoat-core getEndowmentsForConfig with an allowlist policy.
  { loader: "ses-policy", behaviour: "clean", policy: POLICY },
  { loader: "ses-policy", behaviour: "processOn", policy: POLICY },
  { loader: "ses-policy", behaviour: "exportsHostFn", policy: POLICY },
].filter((s) => !values.only || s.loader === values.only);

const scenarioFile = fileURLToPath(new URL("./scenario.mjs", import.meta.url));
const results = [];
for (const scenario of SCENARIOS) {
  for (let run = 1; run <= repeats; run += 1) {
    const child = spawnSync(
      process.execPath,
      ["--expose-gc", "--no-warnings", scenarioFile, JSON.stringify({ ...scenario, versions })],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const line = child.stdout.split("\n").find((l) => l.startsWith("RESULT "));
    if (child.status !== 0 || !line) {
      console.error(`${scenario.loader}/${scenario.behaviour} failed (exit ${child.status})\n${child.stderr}`);
      process.exitCode = 1;
      continue;
    }
    const result = { ...JSON.parse(line.slice("RESULT ".length)), run };
    results.push(result);
    process.stderr.write(`done ${result.loader}/${result.behaviour} run ${run}\n`);
  }
}

console.table(
  results.map((r) => ({
    loader: r.loader,
    behaviour: r.behaviour,
    "loaded ok": r.loadedOk,
    "versions alive": r.versionsStillAlive,
    "heap growth MiB": r.heapGrowthMiB,
    "host global replaced": r.hostGlobalReplaced,
  })),
);
for (const r of results) {
  if (r.firstLoadError) console.log(`${r.loader}/${r.behaviour}: ${r.firstLoadError}`);
}

const require = createRequire(import.meta.url);
const version = (name) => JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8")).version;
const report = {
  date: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  packages: Object.fromEntries(
    ["@module-federation/runtime", "lavamoat-core", "ses"].map((name) => [name, version(name)]),
  ),
  versions,
  repeats,
  results,
};
mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
const out = new URL(`../results/${report.date.replaceAll(":", "-")}.json`, import.meta.url);
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nSaved ${fileURLToPath(out)}`);
