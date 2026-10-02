// A tiny HTTP "CDN" that serves one immutable directory per deployed version:
//
//   /v<N>/remoteEntry.js  — the federation container (init/get)
//   /v<N>/quote.js        — the chunk behind the "./quote" exposure
//
// Both files are CommonJS-shaped, like a webpack `async-node` remote, and are
// generated on request so the server keeps nothing in memory between versions.
import { createServer } from "node:http";

// What the remote's quote chunk does besides pricing. Each snippet runs inside
// the chunk and can see its `rates` array (about 256 KiB per version).
export const BEHAVIOURS = {
  // Uses nothing from the host.
  clean: "",
  // Starts a timer it never clears; the host's timer list keeps the callback.
  setInterval: "setInterval(() => rates.length, 1e7).unref();",
  // Adds a listener to the host's process object.
  processOn: "process.on('beforeExit', () => rates.length);",
  // Re-exports a host global. The host stores that export somewhere long-lived.
  exportsHostFn: "exports.fetcher = fetch;",
  // Assigns to a global that Node defines with a setter.
  overwriteHostGlobal:
    "globalThis.sessionStorage = { leakedFromGeneration: generation, rates };",
};

// Like a real container, the entry caches loaded chunks (webpack keeps them in
// its module cache) and publishes itself on the global object (as
// @module-federation/node's script loader does with `globalThis[key]`). Inside
// a compartment, "the global object" is the compartment's own globalThis.
function remoteEntrySource() {
  return `
let initialized = false;
const loadedChunks = {};
exports.init = function init(shareScope) {
  initialized = true;
};
exports.get = function get(expose) {
  if (!initialized) return Promise.reject(new Error("Container not initialized"));
  if (expose !== "./quote") return Promise.reject(new Error("Unknown exposure " + expose));
  loadedChunks["quote.js"] ??= __federation_load_chunk__("quote.js");
  return loadedChunks["quote.js"].then((chunk) => () => chunk);
};
globalThis.pricing = exports;
`;
}

function quoteChunkSource(generation, behaviour, cells) {
  return `
const generation = ${generation};
const rates = new Array(${cells}).fill(generation + 1);
let calls = 0;
exports.generation = generation;
exports.quote = function quote(input) {
  calls += 1;
  return { generation, calls, total: rates[input.sku % rates.length] * input.quantity };
};
${BEHAVIOURS[behaviour]}
`;
}

export async function startRemoteServer({ behaviour, cells = 32768 }) {
  if (!(behaviour in BEHAVIOURS)) {
    throw new Error(`Unknown behaviour: ${behaviour}`);
  }
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    const match = /^\/v(-?\d+)\/(remoteEntry|quote)\.js$/.exec(req.url ?? "");
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    const generation = Number(match[1]);
    const body =
      match[2] === "remoteEntry"
        ? remoteEntrySource()
        : quoteChunkSource(generation, behaviour, cells);
    res.writeHead(200, {
      "content-type": "application/javascript",
      "cache-control": "public, max-age=31536000, immutable",
      connection: "close",
    });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    entryFor: (generation) =>
      `http://127.0.0.1:${port}/v${generation}/remoteEntry.js`,
    requests: () => requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}
