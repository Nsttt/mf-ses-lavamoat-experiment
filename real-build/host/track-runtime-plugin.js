// Measurement only: keep a WeakRef to each remote container the runtime loads,
// so the experiment can ask the garbage collector which old versions are still
// reachable. It never holds strong references.
//
// The contained loader registers the remote's own container itself (the
// runtime only sees a host-side wrapper there), so it sets loaderTracks.
export default function trackRuntimePlugin() {
  return {
    name: "experiment-track-plugin",
    onLoad(args) {
      const registry = globalThis.__EXPERIMENT_TRACK__;
      const container = args.moduleInstance?.remoteEntryExports;
      if (registry && !registry.loaderTracks && container && !registry.seen.has(container)) {
        registry.seen.add(container);
        registry.containers.push(new WeakRef(container));
      }
      return args;
    },
  };
}
