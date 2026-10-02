# Module Federation remotes in SES compartments, endowed with LavaMoat

Can a Node.js host keep deploying new versions of a Module Federation remote without leaking memory? This repository compares `@module-federation/node`, as documented, against a rewritten loader. The rewrite runs every remote version in its own [SES](https://github.com/endojs/endo/tree/master/packages/ses) compartment and gives it host globals through `lavamoat-core`'s `endowmentsToolkit`.

- **Part 1 (`real-build/`)** builds a real host and remote with Rspack and `@module-federation/enhanced`, deploys new versions over HTTP, and measures correctness and memory.
- **Part 2 (`src/`)** is the earlier synthetic experiment. It loads hand-written remotes through `@module-federation/runtime` to study `lavamoat-core`'s endowments on their own.

All results were measured on 2026-10-02 with Node 26.7.0 on macOS arm64.

# Part 1: real builds, `@module-federation/node` versus a contained loader

## Run it

```sh
npm install
npm run build:real   # builds the remote and the three hosts with Rspack
npm run real         # every scenario in fresh processes, about a minute
npm run real:quick   # smaller deploy counts
```

Results are printed and saved to `results/real-build-<timestamp>.json`.

## What is compared

One remote, `pricing`, is built the documented `@module-federation/node` way: `target: "async-node"`, `library: { type: "commonjs-module" }`, and `@module-federation/node/runtimePlugin`. It exposes `./quote`, which uses the shared `big.js` and lazily loads a chunk with about 256 KiB of pricing data. That makes a version that is never freed easy to see.

A local CDN (`real-build/cdn.mjs`) serves the build as if a new version were deployed on demand. `remoteEntry.js` keeps one URL but its content changes on every deploy, which is what `revalidate()` checks for. Chunks get a new, immutable URL per deploy, like content-hashed filenames.

The host is one request handler that calls `import("pricing/quote")`, built three ways:

| Host              | How it loads and updates the remote                                                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mf-node`         | `@module-federation/node` as documented: its runtime plugin, plus `revalidate()` from `@module-federation/node/utils`, which reloads the whole host bundle when the remote changes.     |
| `mf-node-patched` | The same, with a one-line fix to `performReload()` (`real-build/host/mf-node-patched-hot-reload.js`).                                                                                   |
| `contained`       | The rewrite (`real-build/host/contained-loader.js`): every remote version runs in its own SES compartment, and `revalidate()` swaps only the remote, without reloading the host bundle. |

Before each request the host calls `revalidate()`, as a server would. A deploy counts as stale if none of the next three requests is answered entirely by the new version. Two memory readings are taken:

- **Retained** is heap growth after V8's last-resort GC, the collection V8 runs itself when the heap is nearly full. Memory still counted here can never be reclaimed.
- **Including the V8 code cache** is heap growth after regular GCs. Each deploy evaluates new code, and V8 keeps compiled code for recent sources until it needs the memory back.

## Results

**Well-behaved remote, 100 deploys**

| Host              | Versions alive |    Retained | Incl. V8 code cache | Stale deploys | Deploy to fresh response |
| ----------------- | -------------: | ----------: | ------------------: | ------------: | -----------------------: |
| `mf-node`         |        **100** | **110 MiB** |             111 MiB |             0 |                   8.4 ms |
| `mf-node-patched` |              1 |     0.0 MiB |              21 MiB |             0 |                   8.3 ms |
| `contained`       |              1 |     0.1 MiB |              42 MiB |             0 |                   7.4 ms |

One version alive is the current one.

**1,000 deploys with a 48 MiB heap limit**

`mf-node` crashed with "JavaScript heap out of memory" about a second into the run. At about 1.1 MiB per deploy, a 48 MiB heap fills within a few dozen deploys. `mf-node-patched` and `contained` both completed all 1,000 deploys with no stale deploys and no errors, retaining under 0.4 MiB.

**A remote that leaves something attached to the host, 40 deploys**

| Remote does                    | `mf-node`        | `mf-node-patched`                     | `contained`    |
| ------------------------------ | ---------------- | ------------------------------------- | -------------- |
| `setInterval` it never clears  | 40 alive, 44 MiB | 40 alive, 44 MiB                      | 1 alive, 0 MiB |
| Caches data on `globalThis`    | 40 alive, 44 MiB | 1 alive, but 9.7 MiB of its data kept | 1 alive, 0 MiB |
| Adds a `process.on()` listener | 40 alive, 44 MiB | 40 alive, 44 MiB                      | 1 alive, 0 MiB |

**A request in flight while a new version is deployed, 20 rounds**

Each round starts a request for version N while its chunks are slow, deploys N+1, calls `revalidate()`, and sends more requests. The in-flight request must finish on N and every later request must get N+1.

| Host              | Rounds with a wrong version | Versions alive |
| ----------------- | --------------------------: | -------------: |
| `mf-node`         |                      **20** |             20 |
| `mf-node-patched` |                      **20** |              1 |
| `contained`       |                           0 |              1 |

In all 20 rounds, both `@module-federation/node` hosts kept serving version N after N+1 was deployed, until the next deploy.

## What this shows

**Stock `@module-federation/node` keeps every version it has ever loaded.** That's about 1.1 MiB per deploy here: the remote plus a full copy of the host bundle. `performReload()` removes the host bundle from `require.cache` and then requires it again from inside the old bundle. Node records the old module as the new one's first parent, using a private `node:module_first_parent` reference that JavaScript can't clear. So every reloaded copy holds on to the previous one, and the chain reaches back to the first. A heap snapshot shows this path (`real-build/diagnose-retainers.mjs`).

**A one-line fix stops that leak.** Re-requiring the entry through a fresh `createRequire(entry)` means no old bundle ever becomes a parent. With it, only the current version stays alive, and the process survives 1,000 deploys in a 48 MiB heap. The patched file is in this repo, ready to propose upstream.

**The fix does not help when the remote attaches something to the host.** The remote runs in the host's global scope, so a timer it never clears, a `process` listener or a cache on `globalThis` keeps every old version alive. The contained loader freed old versions in all three cases.

**`revalidate()` can miss a deploy.** It only checks remotes already in a runtime instance's module cache, and after a reload that cache starts empty. The first `revalidate()` after the remote loads again records whatever is on the CDN at that moment as the baseline. If a deploy landed while that load was in flight, it is never detected, and the old version is served until the next deploy. The contained loader hashes exactly the source it evaluated, so it doesn't have this window.

**The documented Rspack setup does not reload at all.** `performReload()` only re-requires the host if `EntryChunkTrackerPlugin` recorded the host's entry chunks. The Rspack instructions don't include it, and `@module-federation/node`'s main entry requires `webpack`, so its webpack plugins can't be loaded in an Rspack build. Without it, the host served version 1 forever. `rspack.config.cjs` ports the plugin's startup snippet with `BannerPlugin`.

**The remote finds its chunk URLs through host globals.** An `async-node` build loads chunks from the filesystem by default, so Rspack omits the public-path runtime even when `output.publicPath` is set. `@module-federation/node` then finds the remote's chunk URLs by searching the host's global `__FEDERATION__` registry. That only works when the remote runs in the host's global scope. `rspack.config.cjs` adds a small plugin that emits the configured public path. Both hosts use the identical remote.

**The contained loader's V8 code cache is larger, but V8 reclaims it.** SES evaluates code through `eval`, and V8 keeps eval-cache entries until it needs memory. Regular GCs do not drop them, last-resort GC does, and with V8's compilation cache disabled (`--no-compilation-cache`) growth is flat. The 48 MiB run shows the effect in practice: no crash and nothing retained.

## How the contained loader works

`real-build/host/contained-loader.js` is a Federation runtime plugin plus a `revalidate()`. It replaces `@module-federation/node/runtimePlugin` in the host. The remote is not modified.

- **One compartment per version.** `loadEntry` fetches the remote entry, creates a `Compartment`, evaluates the entry in it as CommonJS, and returns the container. The remote's own runtime loads its chunks inside the same compartment.
- **Host globals from an allowlist, via `lavamoat-core`.** `getEndowmentsForConfig` grants `fetch`, `URL`, `Response`, `queueMicrotask` and individual `console` methods. Grants use leaf paths, so the host's `console` object itself is never shared. Like `@lavamoat/webpack`, the loader also gives the host's original `Date` and `Math`, because SES tames them in compartments.
- **Function wrappers that hold their compartment weakly.** `lavamoat-core` wraps every granted function so that `this` resolves correctly. Its default wrapper keeps a strong reference to the compartment, so a host that keeps a wrapper (for example an exported `fetch`) keeps the whole version alive. The loader passes its own `createFunctionWrapper`, which reaches the compartment through a `WeakRef`.
- **No setters.** Copied setters would forward writes to the host's global object. They are removed.
- **Timers owned by the compartment.** `setTimeout` and `setInterval` keep the callback in the compartment. The host's timer holds only a `WeakRef` to it and cancels itself once the compartment is collected. Timers work normally while the version is live (checked on every deploy).
- **No `process` or `require`.** The remote's runtime guards `process` and falls back to fetching its chunks over HTTP. `require` always throws.
- **Its own copy of the share scope.** The container would otherwise register its own functions in the host's share scope map. It gets two-level copies, so it reads the host's shared modules and its writes stay its own.
- **SES-compatible code.** SES rejects any source that looks like `import(` or a direct `eval(`, even in comments and strings. Bundler output has both: a chunk comment, and the `eval` that `@module-federation/node`'s chunk loader uses. Compartment `transforms` rewrite them to `__import__(` and to indirect eval, `(0, eval)(`, which behaves the same here.
- **Remote-only updates.** `revalidate()` hashes the remote entry and evaluates exactly the source it hashed. On a change it waits for imports of the old version that are still in flight, then drops the remote from the runtime and from the host bundle's module cache (`__webpack_require__.c`, `.m`, and the remote loading state). The next `import()` gets the new version. Requests still running keep the old version until they finish.

## Is the rewrite worth it?

- **For memory alone, no.** If remotes are trusted and well-behaved, the one-line `performReload()` fix removes the leak at the same reload cost. The `revalidate()` race needs a separate fix, probably small but not tested here: hash the source that was loaded, not what the CDN serves later.
- **For containment, yes.** If you can't guarantee that every remote cleans up after itself, the contained loader is the only variant here that frees old versions whatever the remote does. It also never reloads the host bundle and has no stale-version window during deploys.
- **The rewrite has real costs.** It hardens host `fetch`, `URL` and `Response` (they become frozen for the host too). Remotes only get an explicit allowlist of host APIs, so a remote that needs Node built-ins like `fs` needs that added deliberately. Dynamic `import()` is unavailable inside a compartment, SES has to rewrite some source text, and V8 keeps a larger code cache until memory pressure.

## What Part 1 does not cover

- One remote with one exposed module and one shared dependency. No nested remotes, no manifest-based remotes, no SSR rendering, no remote that needs Node built-ins.
- The share scope copy is shallow. Shared modules themselves are not hardened, so a remote that mutates a shared module still affects the host.
- Static `import` of a remote module captures the old binding forever under any loader. The host here uses `import()` per request.
- The contained loader is not a security review. SES compartments do not limit CPU or memory.
- One machine and one Node version (26.7.0). Each scenario ran once in a fresh process. Version counts and correctness results were identical across the repeated runs made while building this, and heap figures varied by under 1 MiB.

## Files

```
real-build/rspack.config.cjs                  remote and the three host builds
real-build/build.mjs                          runs the Rspack builds
real-build/cdn.mjs                            local CDN that "deploys" a new version on demand
real-build/remote/src/                        the remote: quote.js (exposed), rates.js (lazy chunk)
real-build/host/src/server.js                 the host request handler, identical for every host
real-build/host/contained-loader.js           the rewrite: SES + lavamoat-core runtime plugin and revalidate()
real-build/host/mf-node-patched-hot-reload.js @module-federation/node hot-reload utils with the one-line fix
real-build/host/track-runtime-plugin.js       measurement only: WeakRefs to loaded containers
real-build/scenario.mjs                       one host, one remote behaviour, one fresh process
real-build/run.mjs                            runs every scenario and saves results
real-build/diagnose-*.mjs                     heap snapshot and heap space diagnostics
```

## Diagnostics

```sh
# Which object chain keeps old rates arrays (or large source strings) alive?
node --expose-gc --no-warnings real-build/diagnose-retainers.mjs mf-node 4
node --expose-gc --no-warnings real-build/diagnose-retainers.mjs contained 60 sources
# Which object groups grow between two deploy counts?
node --expose-gc --no-warnings real-build/diagnose-growth.mjs contained 40 80
# Which V8 heap spaces grow, after 30 and 130 full GCs?
node --expose-gc --no-warnings real-build/diagnose-spaces.mjs contained 200
```

# Part 2: synthetic remotes through `@module-federation/runtime`

This earlier experiment loads each deployed version of a hand-written remote into its own SES compartment. It gives that compartment host globals using `lavamoat-core`'s `endowmentsToolkit`. Then it asks one question: **when the host moves on to a newer version, can the old one be garbage-collected?**

Everything goes through the real Federation runtime (`@module-federation/runtime`): `createInstance`, `registerRemotes(..., { force: true })` and `loadRemote("pricing/quote")`. Remote code is served over real HTTP from a local server. It does not use `@module-federation/node`.

## Run it

```sh
npm install
npm start                 # 100 versions per scenario, one fresh process each
npm run quick             # 30 versions
node src/run.mjs --versions 200 --repeats 3
node src/run.mjs --only ses-all
```

Each scenario runs in its own Node process with `--expose-gc`. Results are printed as a table and saved to `results/<timestamp>.json`.

`lavamoat-core@19.0.0` declares Node `^22.5.1 || ^24.0.0`, so npm prints an `EBADENGINE` warning on Node 26. The results below were measured on Node 26.7.0 regardless.

## How it works

`src/remote-server.mjs` is a small CDN. Every version `N` gets its own immutable URL: `/vN/remoteEntry.js` (the container with `init` and `get`) and `/vN/quote.js` (the chunk behind `./quote`). The chunk holds about 256 KiB of pricing data, so a version that is not freed shows up clearly in the heap. Like a real container, the entry caches the chunks it loaded and puts itself on the global object (`globalThis.pricing`).

`src/federation-plugins.mjs` holds two Federation runtime plugins. Both use the runtime's `loadEntry` hook:

- **`nodeVmPlugin`** is the baseline. It fetches the remote, wraps it as a CommonJS function and runs it in the host with the real `require`. That is what `@module-federation/node` does today. The fetch-and-wrap code is adapted from its `fetchAndRun` and `loadFromFs` (MIT). The file header lists what changed.
- **`sesPlugin`** does the same fetch and wrap, but evaluates the code inside a new `Compartment` for every version. The remote gets a `require` that always throws. Chunks are loaded into the same compartment as their entry.

`sesPlugin` supports three ways of giving the compartment host globals:

| Mode     | What the remote can see                                                                                                                                                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`   | Only SES's own compartment globals.                                                                                                                                                                                                                                                                                       |
| `all`    | Every host global, copied by `copyWrappedGlobals(globalThis, compartment.globalThis, aliases)`. This is how `@lavamoat/webpack`'s `runtime.js` sets up its root compartment.                                                                                                                                              |
| `policy` | Only what a LavaMoat-style policy allows, built by `getEndowmentsForConfig(globalThis, { globals }, globalThis, compartment.globalThis)` and installed with `defineProperties`. That mirrors how `runtime.js` handles non-root packages. The policy used here allows `setTimeout`, `clearTimeout`, `fetch` and `console`. |

Do not pass the copied globals as `new Compartment({ globals })`. SES installs `globals` with `Object.assign`, which drops every non-enumerable property (128 of them on Node 26, including `process` and `Buffer`). It also copies the `globalThis` alias over, so the remote's `globalThis` becomes the endowments object rather than the compartment's global. Copy onto `compartment.globalThis` instead, as `runtime.js` does.

## What the remote does in each scenario

| Behaviour             | Extra code in the remote's chunk                                      |
| --------------------- | --------------------------------------------------------------------- |
| `clean`               | Nothing. It only uses its own data.                                   |
| `setInterval`         | Starts a timer and never clears it.                                   |
| `processOn`           | Adds a `process.on("beforeExit")` listener.                           |
| `exportsHostFn`       | Exports `fetch`, and the host keeps that export in a long-lived list. |
| `overwriteHostGlobal` | Assigns `globalThis.sessionStorage = { ... }`.                        |

## Results

2026-10-02, Node 26.7.0, macOS arm64. `@module-federation/runtime` 2.9.2, `lavamoat-core` 19.0.0, `ses` 2.3.0. 100 versions per scenario. All three fresh-process runs gave the same counts, and heap growth varied by at most 0.23 MiB.

"Versions alive" counts how many of the 100 versions could not be collected after forced GC. One is expected: the current version, which the runtime keeps loaded.

| Loader       | Remote behaviour    | Loaded OK | Versions alive | Heap growth | Host global replaced |
| ------------ | ------------------- | --------: | -------------: | ----------: | :------------------: |
| `vm`         | clean               |       100 |              1 |    1.78 MiB |          no          |
| `ses-none`   | clean               |       100 |              1 |    1.84 MiB |          no          |
| `ses-all`    | clean               |       100 |              1 |    1.85 MiB |          no          |
| `ses-all`    | setInterval         |       100 |        **100** |   31.95 MiB |          no          |
| `ses-all`    | processOn           |       100 |        **100** |   31.93 MiB |          no          |
| `ses-all`    | exportsHostFn       |       100 |        **100** |   31.90 MiB |          no          |
| `ses-all`    | overwriteHostGlobal |       100 |              1 |    1.88 MiB |       **yes**        |
| `ses-policy` | clean               |       100 |              1 |    1.84 MiB |          no          |
| `ses-policy` | processOn           |     **0** |              1 |    1.74 MiB |          no          |
| `ses-policy` | exportsHostFn       |       100 |        **100** |   27.74 MiB |          no          |

## What this shows

**The toolkit itself does not leak.** With `copyWrappedGlobals` and a well-behaved remote, every old version was collected, just like the plain `vm` baseline and an empty compartment.

**Anything the host keeps that points into a compartment keeps that whole version alive.** That covers a timer the remote never clears, a listener on `process`, or a function the host caches. Each retained version costs about 0.3 MiB here: the 256 KiB of pricing data plus the compartment and its copied globals.

**A copied host function is not the host's function.** `copyWrappedGlobals` and `getEndowmentsForConfig` wrap every host function so that `this` points at the real global. Each wrapper remembers its compartment's global object. When the remote exports `fetch` and the host stores it, the host is holding that wrapper, which reaches the compartment's global, the container on it, its chunk cache and its data. The policy mode has the same problem, because it uses the same wrappers. To the host this looks like it stored the ordinary `fetch`.

**An allowlist blocks the APIs you leave out, not the ones you allow.** With a policy that does not include `process`, the `process.on` remote fails to load. Nothing leaks, but the remote is unusable. Anything you do allow can still keep a version alive. Policy mode costs about 42 KiB less per retained version than `all` (27.74 vs 31.90 MiB over 100), because it copies 4 globals instead of about 90.

**Remotes can replace some host globals.** On Node 26, `process`, `Buffer`, `performance`, `localStorage` and `sessionStorage` are getter/setter properties on the host global. `copyWrappedGlobals` copies those setters and points them at the real global. When the remote assigns `globalThis.sessionStorage`, the host's `sessionStorage` changes. That breaks containment, and the host keeps the remote's object.

**Other side effects.** Every `copyWrappedGlobals` call runs every getter on the host global. On Node 26 that loads Node's lazily created globals and prints an `ExperimentalWarning` about `localStorage`, which is why the runner passes `--no-warnings`. Copying all globals adds roughly 44 KiB and 0.2 ms per compartment, measured separately with 1,000 live compartments.

## What this does not cover

- The remote is a hand-written CommonJS container, not a bundler build. It has no shared dependencies, no `import()` and no SSR rendering.
- The host calls the remote's functions directly. There is no data-copying bridge between them.
- Heap is measured after forced GC with `--expose-gc`. That says which objects are still reachable, not what memory a production process would use.
- One machine and one Node version. Repeats run in fresh processes, but OS activity is not controlled.
- SES compartments are not a resource limit. A remote can still use CPU and memory without bounds.

## Files

```
src/remote-server.mjs       local HTTP CDN that generates each remote version
src/federation-plugins.mjs  nodeVmPlugin (baseline) and sesPlugin (compartments + lavamoat-core)
src/scenario.mjs            one scenario in one process: deploy N versions, GC, count survivors
src/run.mjs                 runs every scenario in fresh processes, prints and saves results
```
