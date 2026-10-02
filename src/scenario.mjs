// One scenario in one fresh process: deploy N remote versions, load each one
// through the real Module Federation runtime, drop it, then count how many old
// versions the garbage collector could not free.
//
// Run directly:
//   node --expose-gc --no-warnings src/scenario.mjs '{"loader":"ses-all","behaviour":"clean"}'
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { startRemoteServer } from "./remote-server.mjs";

const {
  loader,
  behaviour,
  versions = 100,
  cells = 32768,
  policy = {},
} = JSON.parse(process.argv[2] ?? "{}");
assert.equal(typeof globalThis.gc, "function", "run with --expose-gc");

let plugin;
if (loader.startsWith("ses-")) {
  await import("ses");
  lockdown();
  const { sesPlugin } = await import("./federation-plugins.mjs");
  plugin = sesPlugin({ endowments: loader.slice("ses-".length), policy });
} else if (loader === "vm") {
  const { nodeVmPlugin } = await import("./federation-plugins.mjs");
  plugin = nodeVmPlugin();
} else {
  throw new Error(`Unknown loader: ${loader}`);
}

const { createInstance } = await import("@module-federation/runtime");
const server = await startRemoteServer({ behaviour, cells });
const mf = createInstance({
  name: "host",
  remotes: [],
  shared: {},
  plugins: [plugin],
});

const keptByHost = [];
const loadErrors = [];
let lastGuestWrite;

async function deploy(generation) {
  mf.registerRemotes(
    [{ name: "pricing", entry: server.entryFor(generation) }],
    { force: true },
  );
  try {
    const mod = await mf.loadRemote("pricing/quote");
    assert.deepEqual(mod.quote({ sku: 7, quantity: 3 }), {
      generation,
      calls: 1,
      total: (generation + 1) * 3,
    });
    // A host that caches something the remote exported, e.g. a client factory.
    if (behaviour === "exportsHostFn") keptByHost.push(mod.fetcher);
    // Node's sessionStorage setter stores the value internally; the property
    // stays an accessor, so read it back through the getter.
    if (behaviour === "overwriteHostGlobal") {
      lastGuestWrite = globalThis.sessionStorage?.leakedFromGeneration;
    }
  } catch (error) {
    if (generation >= 0) loadErrors.push(String(error?.message ?? error).split("\n")[0]);
  }
}

async function collect() {
  for (let i = 0; i < 4; i += 1) {
    await nextTurn();
    globalThis.gc();
  }
  return process.memoryUsage().heapUsed;
}

// Warm up so first-load costs (fetch/undici, lazy Node globals, MF runtime
// state) are not counted as growth.
for (let generation = -3; generation < 0; generation += 1) await deploy(generation);
const warmupLoads = plugin.tracked.length;
const baseline = await collect();

for (let generation = 0; generation < versions; generation += 1) {
  await deploy(generation);
}
const final = await collect();

const measured = plugin.tracked.slice(warmupLoads);
const stillAlive = measured.filter((ref) => ref.deref() !== undefined).length;
const result = {
  loader,
  behaviour,
  node: process.version,
  versions,
  loadedOk: versions - loadErrors.length,
  loadErrors: loadErrors.length,
  firstLoadError: loadErrors[0],
  // The currently registered version is expected to stay alive: MF caches it.
  versionsStillAlive: stillAlive,
  heapGrowthMiB: Number(((final - baseline) / 2 ** 20).toFixed(2)),
  hostGlobalReplaced: lastGuestWrite === versions - 1,
  mfModuleCacheSize: mf.moduleCache.size,
  remoteRequests: server.requests(),
};

await server.close();
console.log(`RESULT ${JSON.stringify(result)}`);
process.exit(0);
