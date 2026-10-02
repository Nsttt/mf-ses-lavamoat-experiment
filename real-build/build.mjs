// Builds the remote and every host variant (see rspack.config.cjs).
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { rspack } from "@rspack/core";

const require = createRequire(import.meta.url);
const configs = require("./rspack.config.cjs");

const stats = await new Promise((resolve, reject) =>
  rspack(configs).run((error, result) => (error ? reject(error) : resolve(result))),
);
const info = stats.toJson({ all: false, errors: true, warnings: true });
for (const warning of info.warnings ?? []) console.warn("warning:", warning.message);
if (stats.hasErrors()) {
  for (const error of info.errors ?? []) console.error(error.message);
  process.exit(1);
}
writeFileSync(new URL("./dist/package.json", import.meta.url), `${JSON.stringify({ type: "commonjs" })}\n`);
console.log(`built ${configs.map((c) => c.name).join(", ")}`);
