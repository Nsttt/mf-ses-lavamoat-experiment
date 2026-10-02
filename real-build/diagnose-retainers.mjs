// Diagnostic: after a few deploys, take a heap snapshot and print the
// shortest strong path from the GC roots to each surviving copy of the
// remote's rates array (the ~256 KiB backing store of `new Array(32768)`).
//
//   node --expose-gc --no-warnings real-build/diagnose-retainers.mjs mf-node [deploys]
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getHeapSnapshot } from "node:v8";
import { setImmediate as nextTurn } from "node:timers/promises";
import { startCdn } from "./cdn.mjs";

const variant = process.argv[2] ?? "mf-node";
const deploys = Number(process.argv[3] ?? 4);
// "rates" (default): the remote's 256 KiB rates arrays. "sources": large strings,
// such as the remote entry's source text.
const target = process.argv[4] ?? "rates";
const require = createRequire(import.meta.url);
const hostPath = fileURLToPath(new URL(`./dist/host-${variant}/server.js`, import.meta.url));

if (variant === "contained") {
  await import("ses");
  lockdown({ errorTaming: "unsafe", overrideTaming: "severe" });
}
const cdn = await startCdn({ distDir: fileURLToPath(new URL("./dist/remote", import.meta.url)) });
const loadHost = () => createRequire(hostPath)(hostPath);
let host = loadHost();
for (let generation = 1; generation <= deploys; generation += 1) {
  cdn.deploy(generation);
  for (let i = 0; i < 2; i += 1) {
    if (await host.revalidate()) host = loadHost();
    await host.handle({ sku: 1, quantity: 1 });
  }
}
await cdn.close();
for (let i = 0; i < 4; i += 1) {
  await nextTurn();
  globalThis.gc();
}

const chunks = [];
for await (const chunk of getHeapSnapshot()) chunks.push(chunk);
const snapshot = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const { node_fields, edge_fields, node_types, edge_types } = snapshot.snapshot.meta;
const N = node_fields.length;
const E = edge_fields.length;
const { nodes, edges, strings } = snapshot;
const nodeTypeNames = node_types[0];
const edgeTypeNames = edge_types[0];
const nf = Object.fromEntries(node_fields.map((f, i) => [f, i]));
const ef = Object.fromEntries(edge_fields.map((f, i) => [f, i]));
const nodeCount = nodes.length / N;

const firstEdge = new Uint32Array(nodeCount + 1);
for (let i = 0, e = 0; i < nodeCount; i += 1) {
  firstEdge[i] = e;
  e += nodes[i * N + nf.edge_count] * E;
  firstEdge[i + 1] = e;
}
const nodeName = (i) => strings[nodes[i * N + nf.name]];
const nodeType = (i) => nodeTypeNames[nodes[i * N + nf.type]];
const edgeLabel = (e) => {
  const type = edgeTypeNames[edges[e + ef.type]];
  const nameOrIndex = edges[e + ef.name_or_index];
  return type === "element" || type === "hidden" ? `[${nameOrIndex}]` : String(strings[nameOrIndex] ?? nameOrIndex);
};

const targets = [];
for (let i = 0; i < nodeCount; i += 1) {
  const size = nodes[i * N + nf.self_size];
  if (target === "rates" && nodeType(i) === "array" && size >= 262144 && size < 270000) targets.push(i);
  if (target === "sources" && nodeType(i) === "string" && size >= 200000) targets.push(i);
}
console.log(`${targets.length} ${target === "rates" ? "rates-sized arrays" : "large strings"} alive after ${deploys} deploys (${variant})`);

// BFS from the synthetic root over strong edges.
const parent = new Int32Array(nodeCount).fill(-1);
const parentEdge = new Int32Array(nodeCount).fill(-1);
parent[0] = 0;
const queue = [0];
for (let q = 0; q < queue.length; q += 1) {
  const from = queue[q];
  for (let e = firstEdge[from]; e < firstEdge[from + 1]; e += E) {
    if (edgeTypeNames[edges[e + ef.type]] === "weak") continue;
    const to = edges[e + ef.to_node] / N;
    // V8's string table is weak in practice; look for the real owner.
    if (nodeName(to) === "(Internalized strings)") continue;
    if (parent[to] !== -1) continue;
    parent[to] = from;
    parentEdge[to] = e;
    queue.push(to);
  }
}

const seen = new Set();
for (const target of targets) {
  const path = [];
  for (let i = target; i !== 0 && parent[i] !== -1; i = parent[i]) {
    path.unshift(`${edgeLabel(parentEdge[i])} -> ${nodeType(i)} ${String(nodeName(i)).slice(0, 60)}`);
  }
  const key = path.slice(0, 8).join("\n");
  if (seen.has(key)) continue;
  seen.add(key);
  console.log("\n--- path from GC roots ---");
  for (const step of path) console.log("  " + step);
}
process.exit(0);
