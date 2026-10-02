// About 256 KiB of pricing data per deployed version, so a version that is
// never freed shows up clearly in the heap.
export const generation = Number("__PRICING_GENERATION__");
export const rates = new Array(32768).fill(generation + 1);

// A one-shot timer every version starts, so the experiment can check that
// timers still work for the live version under each loader.
export let timerFired = false;
setTimeout(() => {
  timerFired = true;
}, 0);

// What the remote does besides pricing, chosen by the CDN per experiment run.
// Kept in a variable so the bundler cannot fold the comparisons away.
const behaviour = "__PRICING_BEHAVIOUR__";

if (behaviour === "setInterval") {
  // Starts a timer it never clears.
  setInterval(() => rates.length, 1e7).unref();
}

if (behaviour === "globalCache") {
  // Caches something on the global object, as libraries do for singletons.
  (globalThis.__pricingCache ??= []).push(rates);
}

if (behaviour === "processOn") {
  // Adds a process listener, guarded the way libraries usually guard it.
  if (typeof process !== "undefined" && typeof process.on === "function") {
    process.on("beforeExit", () => rates.length);
  }
}
