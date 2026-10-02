// Contained loader: a Module Federation runtime plugin (replaces
// @module-federation/node/runtimePlugin in the host) plus a revalidate() that
// swaps a remote without reloading the host bundle.
//
// Every remote version runs in its own SES Compartment. The design rule is that
// the host never holds a strong reference into an old compartment once it has
// moved on, whatever the remote does:
//
// - Host globals are granted from a LavaMoat-style allowlist with lavamoat-core,
//   using leaf paths only (console.log, not console), never setters, and a
//   function wrapper that refers to its compartment through a WeakRef.
// - Timers are owned by the compartment: the host's timer only holds a WeakRef
//   to the remote's callback, and cancels itself once that is collected.
// - The remote's container gets its own copy of the share scope, so it cannot
//   register its functions into the host's share registry.
// - revalidate() drops the old version from the runtime and from the host
//   bundle's own module cache, instead of re-requiring the whole host.
//
// Requires ses to be imported and lockdown() called before the host loads.
import { createHash } from "node:crypto";
import endowmentsToolkit from "lavamoat-core/src/endowmentsToolkit.js";

/* global __webpack_require__ */

// What remote code may see, in LavaMoat policy form. Leaf paths only: granting
// a whole host object (e.g. `console: true`) shares that mutable object.
const GLOBALS_POLICY = {
  fetch: true,
  URL: true,
  Response: true,
  "console.log": true,
  "console.info": true,
  "console.warn": true,
  "console.error": true,
  "console.debug": true,
  queueMicrotask: true,
};
const GLOBAL_ALIASES = ["window", "self", "global", "globalThis", "frames"];

// Host constructors the remote can reach through instanceof/prototype; frozen
// so remote code cannot hang its own functions on host prototypes.
let hostIntrinsicsHardened = false;
function hardenGrantedHostValues() {
  if (hostIntrinsicsHardened) return;
  hostIntrinsicsHardened = true;
  for (const name of ["fetch", "URL", "Response", "queueMicrotask"]) harden(globalThis[name]);
}

// SES rejects any source text that looks like import(...), even in comments
// and strings. Bundler output contains both, and the remote's own runtime
// evaluates its chunks with eval inside the compartment, so rewrite them for
// every evaluation in the compartment. Dynamic import is unavailable in a
// compartment anyway.
const evadeImportExpressions = (source) => source.replace(/\bimport(\s*(?:\(|\/[/*]))/g, "__import__$1");

// SES also rejects direct eval, which it cannot give access to local scope.
// @module-federation/node's chunk loader (bundled into the remote) uses eval
// only to create a function and passes everything as arguments, so indirect
// eval is equivalent.
const indirectEval = (source) => source.replace(/\beval(\s*\()/g, "(0, eval)$1");

// --- per-compartment endowments -------------------------------------------

function createEndowments(compartmentGlobal) {
  const globalRef = new WeakRef(compartmentGlobal);

  // Like lavamoat-core's defaultCreateFunctionWrapper, but the wrapper reaches
  // its compartment only through a WeakRef, so a host that keeps a wrapper
  // (e.g. a remote exported `fetch`) does not keep the compartment alive.
  // lavamoat-core's unwrapTest closure is deliberately not retained.
  function createFunctionWrapper(sourceValue, _unwrapTest, unwrapTo) {
    const wrapper = function () {
      "use strict";
      if (new.target) return Reflect.construct(sourceValue, arguments, new.target);
      const thisRef = this !== undefined && this === globalRef.deref() ? unwrapTo : this;
      return Reflect.apply(sourceValue, thisRef, arguments);
    };
    Object.defineProperties(wrapper, Object.getOwnPropertyDescriptors(sourceValue));
    if (Reflect.getPrototypeOf(wrapper) !== Reflect.getPrototypeOf(sourceValue)) {
      Reflect.setPrototypeOf(wrapper, Reflect.getPrototypeOf(sourceValue));
    }
    return harden(wrapper);
  }

  const { getEndowmentsForConfig } = endowmentsToolkit({ createFunctionWrapper });
  const granted = getEndowmentsForConfig(
    globalThis,
    { globals: GLOBALS_POLICY },
    globalThis,
    compartmentGlobal,
  );
  const descriptors = Object.getOwnPropertyDescriptors(granted);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    // Never forward writes to the host: a copied setter would let remote code
    // replace host globals (and keep the host pointing at remote objects).
    if ("set" in descriptor) delete descriptor.set;
    if (!("get" in descriptor) && !("value" in descriptor)) delete descriptors[key];
  }
  return { ...descriptors, ...createTimerEndowments() };
}

// Timers owned by the compartment. `owned` lives in closures on the
// compartment's global object, so callbacks stay alive exactly as long as the
// compartment does. The host-side Timeout only holds a WeakRef to the entry,
// and clears itself when the entry has been collected.
function createTimerEndowments() {
  const owned = new Map();
  let nextId = 1;

  function schedule(hostSchedule, hostClear, repeat, callback, delay, args) {
    if (typeof callback !== "function") throw new TypeError("Timer callback must be a function");
    const id = nextId++;
    const entry = { callback, args };
    owned.set(id, entry);
    const handle = hostSchedule(makeWeakTick(new WeakRef(entry), hostClear, repeat, owned, id), delay);
    entry.handle = handle;
    return harden({
      ref() { handle.ref(); return this; },
      unref() { handle.unref(); return this; },
      hasRef: () => handle.hasRef(),
      [Symbol.toPrimitive]: () => id,
    });
  }

  function clear(timer) {
    const id = typeof timer === "object" && timer !== null ? Number(timer) : timer;
    const entry = owned.get(id);
    if (!entry) return;
    owned.delete(id);
    clearTimeout(entry.handle);
  }

  const value = (fn) => ({ value: harden(fn), writable: true, enumerable: true, configurable: true });
  return {
    setTimeout: value((cb, ms, ...args) => schedule(setTimeout, clearTimeout, false, cb, ms, args)),
    setInterval: value((cb, ms, ...args) => schedule(setInterval, clearInterval, true, cb, ms, args)),
    clearTimeout: value(clear),
    clearInterval: value(clear),
  };
}

// Defined at module scope so the host-side tick closes over nothing but a
// WeakRef, the id and the (compartment-owned) map. `owned` is reached through
// a WeakRef too, so the tick never keeps it alive.
function makeWeakTick(entryRef, hostClear, repeat, owned, id) {
  const ownedRef = new WeakRef(owned);
  return function tick() {
    const entry = entryRef.deref();
    if (!entry) {
      hostClear(this);
      return;
    }
    if (!repeat) ownedRef.deref()?.delete(id);
    Reflect.apply(entry.callback, undefined, entry.args);
  };
}

// --- loading ----------------------------------------------------------------

const denyRequire = harden((specifier) => {
  throw new Error(`require(${JSON.stringify(specifier)}) is not available to contained remotes`);
});

// Entry source fetched by revalidate(), so the loader evaluates exactly the
// version whose hash was compared.
const prefetched = new Map();
const knownHashes = new Map();

async function fetchText(url, loaderHook) {
  const hooked = await loaderHook?.lifecycle.fetch.emit(url, {});
  const response = hooked instanceof Response ? hooked : await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  return response.text();
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function createCompartment(name) {
  const compartment = new Compartment({
    __options__: true,
    name,
    transforms: [evadeImportExpressions, indirectEval],
  });
  const target = compartment.globalThis;
  Object.defineProperties(target, {
    // As @lavamoat/webpack does: SES tames Date and Math in compartments
    // (Date.now() throws). The host originals are hardened shared intrinsics.
    Date: { value: Date, writable: true, configurable: true },
    Math: { value: Math, writable: true, configurable: true },
    ...createEndowments(target),
    ...Object.fromEntries(GLOBAL_ALIASES.map((alias) => [alias, { value: target }])),
  });
  return compartment;
}

// The remote's container would otherwise write its own share registrations
// (functions that close over the old remote) into the host's share scope map.
// Give each container two-level copies: it reads the host's shared modules but
// its writes stay in its own objects.
function copyShareScope(scope) {
  if (!scope || typeof scope !== "object") return scope;
  const copy = {};
  for (const [pkg, versions] of Object.entries(scope)) {
    copy[pkg] = versions && typeof versions === "object" ? { ...versions } : versions;
  }
  return copy;
}

function containInit(container) {
  const init = container.init;
  return {
    get: container.get,
    init(shareScope, initScope, remoteEntryInitOptions) {
      const options = remoteEntryInitOptions && { ...remoteEntryInitOptions };
      if (options?.shareScopeMap) {
        options.shareScopeMap = Object.fromEntries(
          Object.entries(options.shareScopeMap).map(([key, scope]) => [key, copyShareScope(scope)]),
        );
      }
      return init(copyShareScope(shareScope), initScope, options);
    },
  };
}

export default function containedLoaderPlugin() {
  return {
    name: "contained-loader",
    async loadEntry({ remoteInfo, loaderHook }) {
      hardenGrantedHostValues();
      const url = remoteInfo.entry;
      let source = prefetched.get(url);
      prefetched.delete(url);
      source ??= await fetchText(url, loaderHook);
      if (!knownHashes.has(remoteInfo.name)) knownHashes.set(remoteInfo.name, sha256(source));

      const compartment = createCompartment(url);
      const module = { exports: {} };
      const directory = new URL(".", url).pathname;
      const run = compartment.evaluate(
        `(function (exports, module, require, __dirname, __filename) {${source}\n})\n//# sourceURL=${url}`,
      // This check runs before the compartment's transforms; indirectEval has
      // already rewritten every eval( by the time the code is evaluated.
      { __rejectSomeDirectEvalExpressions__: false },
      );
      run(module.exports, module, denyRequire, directory, url);
      const container = module.exports[remoteInfo.entryGlobalName] ?? module.exports;
      // Experiment only: track the remote's own container (it keeps the
      // compartment alive), not the host-side wrapper returned below.
      globalThis.__EXPERIMENT_TRACK__?.containers.push(new WeakRef(container));
      return containInit(container);
    },
  };
}

// --- updates ------------------------------------------------------------------

// Drop everything the host holds for one remote: the runtime's module cache
// and loading state, and the host bundle's own cache of the remote modules it
// imported. The next import() loads the new version into a new compartment.
async function dropRemote(instance, remote) {
  const runtimeOptions = __webpack_require__.federation.bundlerRuntimeOptions.remotes;
  const entries = Object.entries(runtimeOptions.idToExternalAndNameMapping).filter(([id]) =>
    (runtimeOptions.idToRemoteMap[id] ?? []).some((info) => info.name === remote.name),
  );
  // The host bundle caches remote modules in one shared table. If an import of
  // the old version is still in flight, let it finish and store its module
  // first; otherwise it can overwrite the new version's entry after the swap.
  // The in-flight request keeps the old module; later imports get the new one.
  const pending = entries.map(([, data]) => data.p).filter((p) => typeof p?.then === "function");
  if (pending.length) {
    await Promise.allSettled(pending);
    await new Promise((resolve) => setImmediate(resolve));
  }
  instance.registerRemotes([remote], { force: true });
  for (const [id, data] of entries) {
    delete data.p;
    delete __webpack_require__.c[id];
    delete __webpack_require__.m[id];
  }
}

// Same contract as @module-federation/node's revalidate(): resolves true when a
// remote changed. Unlike it, the host bundle is not reloaded.
export async function revalidate() {
  const instance = __webpack_require__.federation.instance;
  let changed = false;
  for (const remote of [...instance.options.remotes]) {
    const source = await fetchText(remote.entry);
    const hash = sha256(source);
    const known = knownHashes.get(remote.name);
    knownHashes.set(remote.name, hash);
    if (known === undefined || known === hash) continue;
    prefetched.set(remote.entry, source);
    await dropRemote(instance, remote);
    changed = true;
  }
  return changed;
}
