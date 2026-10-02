// Exposed as "pricing/quote". Uses the shared "big.js" and lazily loads its
// rates chunk, so both shared-module and chunk loading are exercised.
import Big from "big.js";

// Replaced by the CDN with the deploy number when the file is served.
const entryGeneration = Number("__PRICING_GENERATION__");
let calls = 0;

export async function quote({ sku, quantity }) {
  calls += 1;
  const { generation: ratesGeneration, rates, timerFired } = await import(
    /* webpackChunkName: "rates" */ "./rates.js"
  );
  return {
    entryGeneration,
    ratesGeneration,
    calls,
    timerFired,
    total: new Big(rates[sku % rates.length]).times(quantity).toNumber(),
  };
}
