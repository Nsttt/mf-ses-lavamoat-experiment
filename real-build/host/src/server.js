// The host application: a request handler that uses the federated module the
// usual way, through import(). Identical source for every host variant; only
// "federation-revalidate" is aliased per variant (see rspack.config.cjs).
export { revalidate } from "federation-revalidate";

export async function handle(input) {
  const { quote } = await import("pricing/quote");
  return quote(input);
}
