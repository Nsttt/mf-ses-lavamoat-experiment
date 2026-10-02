// Diagnostic: which kinds of objects keep accumulating across deploys?
// Takes a heap snapshot after A deploys and after B deploys in one process and
// prints the object groups whose total size grew the most, with the shortest
// strong retaining path for a sample of the new objects.
//
//   node --expose-gc --no-warnings real-build/diagnose-growth.mjs contained 40 80
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getHeapSnapshot } from "node:v8";
import { setImmediate as nextTurn } from "node:timers/promises";
import { startCdn } from "./cdn.mjs";

const [variant = "contained", first = "40", second = "80"] = process.argv.slice(2);
const hostPath = fileURLToPath(new URL(`./dist/host-${variant}/server.js`, import.meta.url));
if (variant === "contained") {
  await import("ses");
  lockdown({ errorTaming: "unsafe", overrideTaming: "severe" });
}
const cdn = await startCdn({ distDir: fileURLToPath(new URL("./dist/remote", import.meta.url)) });
const loadHost = () => createRequire(hostPath)(hostPath);
let host = loadHost();
let generation = 0;
async function deploy(count) {
  for (let i = 0; i < count; i += 1) {
    cdn.deploy(++generation);
    for (let r = 0; r < 3; r += 1) {
      if (await host.revalidate()) host = loadHost();
      await host.handle({ sku: 1, quantity: 1 });
    }
  }
  for (let i = 0; i < 6; i += 1) {
    await nextTurn();
    globalThis.gc();
  }
}

async function snapshot() {
  const chunks = [];
  for await (const chunk of getHeapSnapshot()) chunks.push(chunk);
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const { node_fields, edge_fields, node_types, edge_types } = data.snapshot.meta;
  const N = node_fields.length;
  const E = edge_fields.length;
  const nf = Object.fromEntries(node_fields.map((f, i) => [f, i]));
  const ef = Object.fromEntries(edge_fields.map((f, i) => [f, i]));
  const count = data.nodes.length / N;
  const groups = new Map();
  let maxId = 0;
  for (let i = 0; i < count; i += 1) {
    const type = node_types[0][data.nodes[i * N + nf.type]];
    const name = String(data.strings[data.nodes[i * N + nf.name]]).slice(0, 70);
    const key = `${type} ${type === "string" || type === "concatenated string" ? "" : name}`;
    const g = groups.get(key) ?? { count: 0, size: 0 };
    g.count += 1;
    g.size += data.nodes[i * N + nf.self_size];
    groups.set(key, g);
    maxId = Math.max(maxId, data.nodes[i * N + nf.id]);
  }
  return { data, N, E, nf, ef, count, groups, maxId, edge_types, node_types };
}

await deploy(Number(first));
const before = await snapshot();
// Snapshot ids grow monotonically: anything above this id is new.
const { groups: beforeGroups, maxId: beforeMaxId } = before;
before.data = undefined;
await deploy(Number(second) - Number(first));
const after = await snapshot();
await cdn.close();

const rows = [...after.groups]
  .map(([key, g]) => {
    const b = beforeGroups.get(key) ?? { count: 0, size: 0 };
    return { key, count: g.count - b.count, size: g.size - b.size };
  })
  .sort((a, b) => b.size - a.size)
  .slice(0, 15);
console.log(`\nGrowth from ${first} to ${second} deploys (${variant}):`);
for (const r of rows) console.log(`${(r.size / 1024).toFixed(1).padStart(9)} KiB  ${String(r.count).padStart(7)} objs  ${r.key}`);

// Retaining paths for new objects in the top groups.
const { data, N, E, nf, ef, count, edge_types, node_types } = after;
const firstEdge = new Uint32Array(count + 1);
for (let i = 0, e = 0; i < count; i += 1) {
  firstEdge[i] = e;
  e += data.nodes[i * N + nf.edge_count] * E;
  firstEdge[i + 1] = e;
}
const parent = new Int32Array(count).fill(-1);
const parentEdge = new Int32Array(count).fill(-1);
parent[0] = 0;
const queue = [0];
for (let q = 0; q < queue.length; q += 1) {
  const from = queue[q];
  for (let e = firstEdge[from]; e < firstEdge[from + 1]; e += E) {
    if (edge_types[0][data.edges[e + ef.type]] === "weak") continue;
    const to = data.edges[e + ef.to_node] / N;
    if (parent[to] !== -1) continue;
    parent[to] = from;
    parentEdge[to] = e;
    queue.push(to);
  }
}
const label = (i) => `${node_types[0][data.nodes[i * N + nf.type]]} ${String(data.strings[data.nodes[i * N + nf.name]]).slice(0, 50)}`;
const edgeLabel = (e) => {
  const type = edge_types[0][data.edges[e + ef.type]];
  const v = data.edges[e + ef.name_or_index];
  return type === "element" || type === "hidden" ? `[${v}]` : String(data.strings[v] ?? v);
};
for (const row of rows.slice(0, 5)) {
  let sample = -1;
  for (let i = 0; i < count; i += 1) {
    if (data.nodes[i * N + nf.id] <= beforeMaxId) continue;
    const type = node_types[0][data.nodes[i * N + nf.type]];
    const name = String(data.strings[data.nodes[i * N + nf.name]]).slice(0, 70);
    const key = `${type} ${type === "string" || type === "concatenated string" ? "" : name}`;
    if (key === row.key) { sample = i; break; }
  }
  if (sample < 0) continue;
  const path = [];
  for (let i = sample; i !== 0 && parent[i] !== -1 && path.length < 40; i = parent[i]) {
    path.unshift(`${edgeLabel(parentEdge[i])} -> ${label(i)}`);
  }
  console.log(`\n--- a new "${row.key}" is retained by ---`);
  for (const step of path) console.log("  " + step);
}
process.exit(0);
