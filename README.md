# Module Federation remotes in SES compartments, endowed with LavaMoat

This experiment loads each deployed version of a Module Federation remote into its own [SES](https://github.com/endojs/endo/tree/master/packages/ses) compartment. It gives that compartment host globals using `lavamoat-core`'s `endowmentsToolkit`. Then it asks one question: **when the host moves on to a newer version, can the old one be garbage-collected?**

Everything goes through the real Federation runtime (`@module-federation/runtime`): `createInstance`, `registerRemotes(..., { force: true })` and `loadRemote("pricing/quote")`. Remote code is served over real HTTP from a local server.

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

| Mode     | What the remote can see                                                                                                                                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`   | Only SES's own compartment globals.                                                                                                                                                                                                                                             |
| `all`    | Every host global, copied by `copyWrappedGlobals(globalThis, compartment.globalThis, aliases)`. This is how `@lavamoat/webpack`'s `runtime.js` sets up its root compartment.                                                                                                     |
| `policy` | Only what a LavaMoat-style policy allows, built by `getEndowmentsForConfig(globalThis, { globals }, globalThis, compartment.globalThis)` and installed with `defineProperties`. That mirrors how `runtime.js` handles non-root packages. The policy used here allows `setTimeout`, `clearTimeout`, `fetch` and `console`. |

Do not pass the copied globals as `new Compartment({ globals })`. SES installs `globals` with `Object.assign`, which drops every non-enumerable property (128 of them on Node 26, including `process` and `Buffer`). It also copies the `globalThis` alias over, so the remote's `globalThis` becomes the endowments object rather than the compartment's global. Copy onto `compartment.globalThis` instead, as `runtime.js` does.

## What the remote does in each scenario

| Behaviour             | Extra code in the remote's chunk                                  |
| --------------------- | ----------------------------------------------------------------- |
| `clean`               | Nothing. It only uses its own data.                               |
| `setInterval`         | Starts a timer and never clears it.                               |
| `processOn`           | Adds a `process.on("beforeExit")` listener.                       |
| `exportsHostFn`       | Exports `fetch`, and the host keeps that export in a long-lived list. |
| `overwriteHostGlobal` | Assigns `globalThis.sessionStorage = { ... }`.                    |

## Results

2026-10-02, Node 26.7.0, macOS arm64. `@module-federation/runtime` 2.9.2, `lavamoat-core` 19.0.0, `ses` 2.3.0. 100 versions per scenario. All three fresh-process runs gave the same counts, and heap growth varied by at most 0.23 MiB.

"Versions alive" counts how many of the 100 versions could not be collected after forced GC. One is expected: the current version, which the runtime keeps loaded.

| Loader       | Remote behaviour      | Loaded OK | Versions alive | Heap growth | Host global replaced |
| ------------ | --------------------- | --------: | -------------: | ----------: | :------------------: |
| `vm`         | clean                 |       100 |              1 |    1.78 MiB |          no          |
| `ses-none`   | clean                 |       100 |              1 |    1.84 MiB |          no          |
| `ses-all`    | clean                 |       100 |              1 |    1.85 MiB |          no          |
| `ses-all`    | setInterval           |       100 |        **100** |   31.95 MiB |          no          |
| `ses-all`    | processOn             |       100 |        **100** |   31.93 MiB |          no          |
| `ses-all`    | exportsHostFn         |       100 |        **100** |   31.90 MiB |          no          |
| `ses-all`    | overwriteHostGlobal   |       100 |              1 |    1.88 MiB |       **yes**        |
| `ses-policy` | clean                 |       100 |              1 |    1.84 MiB |          no          |
| `ses-policy` | processOn             |     **0** |              1 |    1.74 MiB |          no          |
| `ses-policy` | exportsHostFn         |       100 |        **100** |   27.74 MiB |          no          |

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
