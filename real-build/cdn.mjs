// Serves the built remote as if a new version were deployed on demand.
//
// /remoteEntry.js is a stable URL whose content changes with every deploy.
// Chunks are served as /<name>.<generation>.js: immutable, one URL per deploy,
// like content-hashed filenames. Placeholders in the build output are replaced
// with the deploy number and the configured remote behaviour.
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";

const PLACEHOLDER = "__PRICING_GENERATION__";

export async function startCdn({ distDir, port = 4317, behaviour = "clean" }) {
  const files = new Map(
    readdirSync(distDir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => [name, readFileSync(new URL(name, `file://${distDir}/`), "utf8")]),
  );
  let generation = 0;
  let requests = 0;
  let chunkDelayMs = 0;

  const render = (source, gen) =>
    source
      .replaceAll(PLACEHOLDER, String(gen))
      .replaceAll("__PRICING_BEHAVIOUR__", behaviour);

  const server = createServer(async (req, res) => {
    requests += 1;
    const url = new URL(req.url ?? "/", "http://cdn");
    let body;
    if (url.pathname === "/remoteEntry.js") {
      body = render(files.get("remoteEntry.js"), generation);
    } else {
      const match = /^\/(.+)\.(\d+)\.js$/.exec(url.pathname);
      const template = match && files.get(`${match[1]}.${PLACEHOLDER}.js`);
      if (template) {
        if (chunkDelayMs) await new Promise((r) => setTimeout(r, chunkDelayMs));
        body = render(template, Number(match[2]));
      }
    }
    if (body === undefined) {
      res.writeHead(404, { connection: "close" }).end();
      return;
    }
    res.writeHead(200, {
      "content-type": "application/javascript",
      "cache-control":
        url.pathname === "/remoteEntry.js" ? "no-cache" : "public, max-age=31536000, immutable",
      connection: "close",
    });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    deploy(next) {
      generation = next;
    },
    get generation() {
      return generation;
    },
    setChunkDelay(ms) {
      chunkDelayMs = ms;
    },
    requests: () => requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}
