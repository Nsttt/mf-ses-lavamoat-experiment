// One host variant, one remote behaviour, one fresh process.
//
// For every deploy: the CDN starts serving a new version, the host calls its
// revalidate(), then a request checks that the answer came from the new
// version (both the exposed module and its lazily loaded chunk). At the end,
// forced GC shows how many old versions are still reachable.
//
//   node --expose-gc --no-warnings real-build/scenario.mjs '{"variant":"mf-node","behaviour":"clean","deploys":50}'
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";
import { setImmediate as nextTurn } from "node:timers/promises";
import { startCdn } from "./cdn.mjs";

const {
  variant,
  behaviour = "clean",
  deploys = 50,
  inFlight = false,
} = JSON.parse(process.argv[2] ?? "{}");
assert.equal(typeof globalThis.gc, "function", "run with --expose-gc");

const require = createRequire(import.meta.url);
const hostPath = fileURLToPath(new URL(`./dist/host-${variant}/server.js`, import.meta.url));
const distDir = fileURLToPath(new URL("./dist/remote", import.meta.url));

if (variant === "contained") {
  await import("ses");
  lockdown({ errorTaming: "unsafe", overrideTaming: "severe" });
}

globalThis.__EXPERIMENT_TRACK__ = {
  containers: [],
  seen: new WeakSet(),
  loaderTracks: variant === "contained",
};
const cdn = await startCdn({ distDir, behaviour });
// Load the host through a throwaway parent each time. A long-lived module that
// calls require(hostPath) again after a reload gets each new copy appended to
// its own module.children (Node does this even for cached modules), which
// would keep every copy alive and measure this harness, not the loader.
const loadHost = () => createRequire(hostPath)(hostPath);
let host = loadHost();

const results = { stale: 0, errors: [], reloads: 0, cycleMs: [], requestsToFresh: [] };

const REQUESTS_PER_DEPLOY = 3;

// A server calls revalidate() before handling each request (or on a timer).
async function serveRequest() {
  if (await host.revalidate()) {
    results.reloads += 1;
    // performReload() re-requires tracked entry chunks; pick up whatever
    // module the require cache now holds for the host bundle.
    host = loadHost();
  }
  const answer = await host.handle({ sku: 7, quantity: 3 });
  assert.equal(answer.total, (answer.ratesGeneration + 1) * 3);
  return answer;
}

// Deploy, then serve REQUESTS_PER_DEPLOY requests, as steady traffic between
// deploys would. The deploy counts as stale if none of them is answered
// entirely by the new version.
async function deployAndServe(generation) {
  cdn.deploy(generation);
  const started = performance.now();
  let fresh = false;
  try {
    for (let request = 1; request <= REQUESTS_PER_DEPLOY; request += 1) {
      const answer = await serveRequest();
      const isFresh =
        answer.entryGeneration === generation && answer.ratesGeneration === generation;
      if (isFresh && !fresh) {
        fresh = true;
        results.cycleMs.push(performance.now() - started);
        results.requestsToFresh.push(request);
      }
      if (!isFresh && fresh) {
        // Went back to an older version after serving the new one.
        results.regressions = (results.regressions ?? 0) + 1;
      }
      if (request === REQUESTS_PER_DEPLOY && !fresh) {
        results.stale += 1;
        results.lastStale ??= { expected: generation, got: answer };
      }
      // Every version starts a one-shot setTimeout(0) when its rates chunk
      // loads; by the last request it must have fired.
      if (request === REQUESTS_PER_DEPLOY && isFresh && !answer.timerFired) {
        results.timersNotFired = (results.timersNotFired ?? 0) + 1;
      }
    }
  } catch (error) {
    results.errors.push(String(error?.message ?? error).split("\n")[0]);
  }
}

// In-flight mode: a request is still loading version N (its chunks are slow)
// when version N+1 is deployed and revalidate() swaps it. The in-flight
// request must finish on N; requests after the swap must get N+1.
async function deployWithRequestInFlight(generation) {
  try {
    cdn.deploy(generation);
    if (await host.revalidate()) {
      results.reloads += 1;
      host = loadHost();
    }
    // Steady traffic revalidates between deploys; @module-federation/node needs
    // this to record the new baseline hash after a reload.
    await host.revalidate();
    cdn.setChunkDelay(40);
    const inFlight = host.handle({ sku: 7, quantity: 3 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    cdn.deploy(generation + 1);
    if (await host.revalidate()) {
      results.reloads += 1;
      host = loadHost();
    }
    const after = host.handle({ sku: 7, quantity: 3 });
    const [old, fresh] = await Promise.all([inFlight, after]);
    cdn.setChunkDelay(0);
    const next = await host.handle({ sku: 7, quantity: 3 });
    const wrong = [];
    if (old.entryGeneration !== generation || old.ratesGeneration !== generation) wrong.push(`in-flight got ${old.entryGeneration}/${old.ratesGeneration}`);
    if (fresh.entryGeneration !== generation + 1 || fresh.ratesGeneration !== generation + 1) wrong.push(`after swap got ${fresh.entryGeneration}/${fresh.ratesGeneration}`);
    if (next.entryGeneration !== generation + 1) wrong.push(`next got ${next.entryGeneration}`);
    if (wrong.length) {
      results.inFlightWrong = (results.inFlightWrong ?? 0) + 1;
      results.firstInFlightWrong ??= `deploy ${generation}: ${wrong.join(", ")}`;
    }
  } catch (error) {
    cdn.setChunkDelay(0);
    results.errors.push(String(error?.message ?? error).split("\n")[0]);
  }
}

// Regular full GCs, then V8's last-resort collection: the one V8 runs itself
// when the heap is nearly full. Unlike a regular GC it also empties V8's
// compilation cache, which otherwise holds recently evaluated sources (each
// deploy evaluates new remote code) and would show up as growth that V8 gives
// back under memory pressure anyway. Both readings are reported.
async function collect() {
  for (let i = 0; i < 4; i += 1) {
    await nextTurn();
    globalThis.gc();
  }
  const regular = process.memoryUsage().heapUsed;
  await nextTurn();
  globalThis.gc({ type: "major", execution: "sync", flavor: "last-resort" });
  await nextTurn();
  globalThis.gc();
  return { regular, lastResort: process.memoryUsage().heapUsed };
}

const WARMUP = 3;
for (let generation = 1; generation <= WARMUP; generation += 1) await deployAndServe(generation);
const warmupContainers = globalThis.__EXPERIMENT_TRACK__.containers.length;
const errorsDuringWarmup = results.errors.length;
const baseline = await collect();
const nativeContextsBefore = getHeapStatistics().number_of_native_contexts;

if (inFlight) {
  // Each round deploys two versions (N, then N+1 while N is still loading).
  for (let round = 0; round < deploys; round += 1) {
    await deployWithRequestInFlight(WARMUP + 1 + round * 2);
  }
} else {
  for (let generation = WARMUP + 1; generation <= WARMUP + deploys; generation += 1) {
    await deployAndServe(generation);
  }
}
const final = await collect();

const measured = globalThis.__EXPERIMENT_TRACK__.containers.slice(warmupContainers);

// Diagnostic: how many host bundle copies are linked through Node's module
// tree (each parent keeps its children in module.children).
let hostModuleChain = 0;
for (let mod = require.cache[hostPath]; mod; mod = mod.parent) {
  if (mod.filename === hostPath) hostModuleChain += 1;
}
const sorted = results.cycleMs.slice(WARMUP).sort((a, b) => a - b);
const result = {
  variant,
  behaviour,
  node: process.version,
  deploys,
  containersLoaded: measured.length,
  // The current version is expected to stay alive.
  versionsAlive: measured.filter((ref) => ref.deref() !== undefined).length,
  // After regular GCs (includes V8's compilation cache) and after V8's
  // last-resort GC (what V8 can actually reclaim under memory pressure).
  heapGrowthMiB: Number(((final.regular - baseline.regular) / 2 ** 20).toFixed(2)),
  retainedGrowthMiB: Number(((final.lastResort - baseline.lastResort) / 2 ** 20).toFixed(2)),
  nativeContextGrowth: getHeapStatistics().number_of_native_contexts - nativeContextsBefore,
  inFlight,
  staleDeploys: results.stale,
  regressions: results.regressions ?? 0,
  timersNotFired: results.timersNotFired ?? 0,
  inFlightWrong: results.inFlightWrong ?? 0,
  firstInFlightWrong: results.firstInFlightWrong,
  lastStale: results.lastStale,
  errors: results.errors.length,
  errorsDuringWarmup,
  firstError: results.errors[0],
  reloads: results.reloads,
  hostModuleChain,
  medianRequestsToFresh: results.requestsToFresh.slice(WARMUP).sort((a, b) => a - b)[
    Math.floor((results.requestsToFresh.length - WARMUP) / 2)
  ],
  medianDeployToFreshMs: Number((sorted[Math.floor(sorted.length / 2)] ?? NaN).toFixed(2)),
  cdnRequests: cdn.requests(),
};

await cdn.close();
console.log(`RESULT ${JSON.stringify(result)}`);
process.exit(0);
