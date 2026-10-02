// Builds one real remote and two hosts with Rspack + @module-federation/enhanced.
//
//   dist/remote         the "pricing" remote, built the documented
//                       @module-federation/node way (async-node, commonjs-module)
//   dist/host-mf-node   host using @module-federation/node as documented
//   dist/host-contained host using the SES + LavaMoat contained loader
//
// The remote's chunk filenames contain a __PRICING_GENERATION__ placeholder.
// The CDN replaces it with the deploy number when serving, so every deploy
// behaves like a content-hashed release: remoteEntry.js keeps its URL but its
// content changes, and chunks get new immutable URLs.
const path = require("node:path");
const { ModuleFederationPlugin } = require("@module-federation/enhanced/rspack");
const { rspack } = require("@rspack/core");

const REMOTE_ORIGIN = process.env.REMOTE_ORIGIN ?? "http://127.0.0.1:4317";
const shared = {
  "big.js": { singleton: true, requiredVersion: "^7.0.0" },
};

const common = {
  mode: "production",
  target: "async-node",
  devtool: false,
  optimization: { minimize: false },
  // The CDN performs string replacement; keep module ids readable and stable.
  infrastructureLogging: { level: "warn" },
  stats: "errors-warnings",
};

// An async-node build loads its chunks from the filesystem by default, so Rspack
// omits the public-path runtime even when output.publicPath is set. Without
// it, @module-federation/node finds chunk URLs by searching the host's global
// __FEDERATION__ registry for the remote's entry, which only works when the
// remote runs in the host's global scope. Emit the configured public path.
class EmitPublicPathPlugin {
  apply(compiler) {
    const { RuntimeGlobals } = compiler.webpack;
    compiler.hooks.thisCompilation.tap("EmitPublicPathPlugin", (compilation) => {
      compilation.hooks.additionalTreeRuntimeRequirements.tap("EmitPublicPathPlugin", (_chunk, set) => {
        set.add(RuntimeGlobals.publicPath);
      });
    });
  }
}

const remote = {
  ...common,
  name: "remote",
  context: path.join(__dirname, "remote"),
  entry: {},
  output: {
    path: path.join(__dirname, "dist/remote"),
    // Absolute CDN URL, as production remotes usually have. With "auto" the
    // node runtime plugin falls back to searching the host's global
    // __FEDERATION__ registry for its own entry URL.
    publicPath: `${REMOTE_ORIGIN}/`,
    chunkFilename: "[name].__PRICING_GENERATION__.js",
    clean: true,
  },
  plugins: [
    new EmitPublicPathPlugin(),
    new ModuleFederationPlugin({
      name: "pricing",
      filename: "remoteEntry.js",
      library: { type: "commonjs-module", name: "pricing" },
      runtimePlugins: [require.resolve("@module-federation/node/runtimePlugin")],
      exposes: { "./quote": "./src/quote.js" },
      shared,
      manifest: false,
      dts: false,
    }),
  ],
};

function entryChunkTracker() {
  return new rspack.BannerPlugin({
    raw: true,
    entryOnly: true,
    banner: [
      "if (typeof module !== \"undefined\") {",
      "  globalThis.entryChunkCache = globalThis.entryChunkCache || new Set();",
      "  module.filename && globalThis.entryChunkCache.add(module.filename);",
      "  if (module.children) module.children.forEach(function (c) {",
      "    c.filename && globalThis.entryChunkCache.add(c.filename);",
      "  });",
      "}",
    ].join("\n"),
  });
}

function host(variant, runtimePlugins, alias = {}, extraPlugins = []) {
  return {
    ...common,
    name: `host-${variant}`,
    context: path.join(__dirname, "host"),
    entry: { server: "./src/server.js" },
    output: {
      path: path.join(__dirname, `dist/host-${variant}`),
      filename: "[name].js",
      chunkFilename: "[name].js",
      library: { type: "commonjs2" },
      clean: true,
    },
    resolve: { alias },
    plugins: [
      new ModuleFederationPlugin({
        name: `host_${variant.replace(/-/g, "_")}`,
        remoteType: "script",
        remotes: { pricing: `pricing@${REMOTE_ORIGIN}/remoteEntry.js` },
        runtimePlugins: [
          ...runtimePlugins,
          path.join(__dirname, "host/track-runtime-plugin.js"),
        ],
        shared,
        manifest: false,
        dts: false,
      }),
      ...extraPlugins,
    ],
  };
}

module.exports = [
  remote,
  // @module-federation/node's EntryChunkTrackerPlugin records the host's entry
  // chunks in globalThis.entryChunkCache so performReload() can drop and
  // re-require them. Without it the host keeps its cached copy of every remote
  // module. The package's main entry requires webpack, so this is the same
  // startup snippet, ported to Rspack with BannerPlugin.
  host(
    "mf-node",
    [require.resolve("@module-federation/node/runtimePlugin")],
    { "federation-revalidate$": require.resolve("@module-federation/node/utils") },
    [entryChunkTracker()],
  ),
  // SES compartments + lavamoat-core endowments, remote-only updates.
  host(
    "contained",
    [path.join(__dirname, "host/contained-loader.js")],
    { "federation-revalidate$": path.join(__dirname, "host/contained-loader.js") },
  ),
  // Same as mf-node, with a one-line fix to performReload() (see the file).
  host(
    "mf-node-patched",
    [require.resolve("@module-federation/node/runtimePlugin")],
    { "federation-revalidate$": path.join(__dirname, "host/mf-node-patched-hot-reload.js") },
    [entryChunkTracker()],
  ),
];
