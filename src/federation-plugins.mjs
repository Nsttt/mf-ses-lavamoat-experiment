// Module Federation runtime plugins that load a remote's CommonJS entry and
// chunks over HTTP, either straight into the host (baseline) or into one SES
// compartment per remote version.
//
// The fetch-and-wrap logic is adapted from `fetchAndRun` and `loadFromFs` in
// @module-federation/node 2.7.52 (src/runtimePlugin.ts), MIT License,
// Copyright (c) 2020 ScriptedAlchemy LLC (Zack Jackson) and contributors.
// Changes: no webpack globals (__webpack_require__, __non_webpack_require__),
// promise-based, wired to the runtime's `loadEntry` hook instead of webpack's
// chunk handlers, and an extra `__federation_load_chunk__` wrapper parameter so
// the remote entry can load its own chunks through the same path.
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const endowmentsToolkit = require("lavamoat-core/src/endowmentsToolkit.js");

// Same aliases @lavamoat/webpack pins on every compartment global.
const GLOBAL_ALIASES = ["window", "self", "global", "globalThis", "frames"];

const CJS_WRAPPER_PARAMS =
  "exports, require, __dirname, __filename, __federation_load_chunk__";

// Like @module-federation/node: give the runtime's `fetch` hook the first
// chance to answer, then fall back to the global fetch.
async function fetchSource(url, loaderHook) {
  const hooked = await loaderHook?.lifecycle.fetch.emit(url.href, {});
  const response = hooked instanceof Response ? hooked : await fetch(url.href);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url.href}: HTTP ${response.status}`);
  }
  return response.text();
}

function dirnameOf(url) {
  return url.pathname.split("/").slice(0, -1).join("/");
}

/**
 * Baseline: evaluate the remote straight into the host realm with the host's
 * `require`, the way @module-federation/node does. No containment at all.
 */
export function nodeVmPlugin() {
  const tracked = [];

  async function loadInto(url, loaderHook) {
    const source = await fetchSource(url, loaderHook);
    const chunk = {};
    const fn = new vm.Script(`(function(${CJS_WRAPPER_PARAMS}) {${source}\n})`, {
      filename: url.href,
      importModuleDynamically: vm.constants?.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    }).runInThisContext();
    const loadChunk = (name) => loadInto(new URL(name, url), loaderHook);
    fn(chunk, require, dirnameOf(url), url.href, loadChunk);
    return chunk;
  }

  return {
    name: "node-vm-federation-plugin",
    tracked,
    async loadEntry({ remoteInfo, loaderHook }) {
      const entry = await loadInto(new URL(remoteInfo.entry), loaderHook);
      tracked.push(new WeakRef(entry));
      return entry;
    },
  };
}

/**
 * Load each remote version into its own SES compartment.
 *
 * Requires `lockdown()` to have run. Endowment modes:
 * - "none": only the compartment's own SES globals.
 * - "all": lavamoat-core `copyWrappedGlobals`, as @lavamoat/webpack does for
 *   its root compartment. The remote gets every host global.
 * - "policy": lavamoat-core `getEndowmentsForConfig` with a LavaMoat-style
 *   `{ globals }` policy, installed the way @lavamoat/webpack installs
 *   endowments for non-root packages.
 */
export function sesPlugin({ endowments = "none", policy = {} } = {}) {
  if (typeof Compartment !== "function" || typeof harden !== "function") {
    throw new Error("Import 'ses' and call lockdown() before creating sesPlugin");
  }
  const { copyWrappedGlobals, getEndowmentsForConfig } = endowmentsToolkit();
  const tracked = [];

  // The remote never gets the host's require.
  const denyRequire = harden((specifier) => {
    throw new Error(`require(${JSON.stringify(specifier)}) is not available in this compartment`);
  });

  function createCompartment(name) {
    const compartment = new Compartment({ __options__: true, name });
    const target = compartment.globalThis;
    if (endowments === "all") {
      // Copy onto the compartment's own globalThis, not into a `globals`
      // object: SES installs `globals` with Object.assign, which drops
      // non-enumerable properties and copies the `globalThis` alias over.
      copyWrappedGlobals(globalThis, target, GLOBAL_ALIASES);
    } else if (endowments === "policy") {
      const granted = getEndowmentsForConfig(globalThis, { globals: policy }, globalThis, target);
      Object.defineProperties(target, {
        ...Object.getOwnPropertyDescriptors(granted),
        ...Object.fromEntries(GLOBAL_ALIASES.map((alias) => [alias, { value: target }])),
      });
    } else if (endowments !== "none") {
      throw new Error(`Unknown endowments mode: ${endowments}`);
    }
    return compartment;
  }

  async function loadInto(compartment, url, loaderHook) {
    const source = await fetchSource(url, loaderHook);
    const chunk = {};
    const fn = compartment.evaluate(
      `(function(${CJS_WRAPPER_PARAMS}) {${source}\n})\n//# sourceURL=${url.href}`,
    );
    const loadChunk = harden((name) => loadInto(compartment, new URL(name, url), loaderHook));
    fn(chunk, denyRequire, dirnameOf(url), url.href, loadChunk);
    return chunk;
  }

  return {
    name: `ses-${endowments}-federation-plugin`,
    tracked,
    async loadEntry({ remoteInfo, loaderHook }) {
      const url = new URL(remoteInfo.entry);
      const compartment = createCompartment(url.href);
      const entry = await loadInto(compartment, url, loaderHook);
      tracked.push(new WeakRef(compartment.globalThis));
      return entry;
    },
  };
}
