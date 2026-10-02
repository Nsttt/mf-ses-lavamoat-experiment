// Diagnostic: after N deploys and many full GCs, which V8 heap spaces grew?
//   node --expose-gc --no-warnings real-build/diagnose-spaces.mjs contained 200
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getHeapSpaceStatistics } from "node:v8";
import { setImmediate as nextTurn } from "node:timers/promises";
import { startCdn } from "./cdn.mjs";

const [variant = "contained", deploys = "200"] = process.argv.slice(2);
const hostPath = fileURLToPath(new URL(`./dist/host-${variant}/server.js`, import.meta.url));
if (variant === "contained") {
  await import("ses");
  lockdown({ errorTaming: "unsafe", overrideTaming: "severe" });
}
const cdn = await startCdn({ distDir: fileURLToPath(new URL("./dist/remote", import.meta.url)) });
const loadHost = () => createRequire(hostPath)(hostPath);
let host = loadHost();
let generation = 0;
async function run(count) {
  for (let i = 0; i < count; i += 1) {
    cdn.deploy(++generation);
    for (let r = 0; r < 3; r += 1) {
      if (await host.revalidate()) host = loadHost();
      await host.handle({ sku: 1, quantity: 1 });
    }
  }
}
async function settle(rounds) {
  for (let i = 0; i < rounds; i += 1) {
    await nextTurn();
    globalThis.gc();
  }
}
const spaces = () => Object.fromEntries(getHeapSpaceStatistics().map((s) => [s.space_name, s.space_used_size]));
await run(5);
await settle(30);
const before = spaces();
await run(Number(deploys));
await settle(30);
const after = spaces();
await settle(100);
const later = spaces();
await cdn.close();
const mib = (n) => (n / 2 ** 20).toFixed(2).padStart(8);
console.log(`${variant}, ${deploys} deploys. Growth per space (MiB), after 30 and after 130 full GCs:`);
for (const name of Object.keys(after)) {
  const a = after[name] - before[name];
  const b = later[name] - before[name];
  if (Math.abs(a) > 0.05 || Math.abs(b) > 0.05) console.log(`  ${name.padEnd(28)}${mib(a)}${mib(b)}`);
}
process.exit(0);
