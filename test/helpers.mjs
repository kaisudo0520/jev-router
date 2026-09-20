import http from "node:http";

/**
 * Applies `vars` to the environment and returns a function that restores what was there.
 * A value of `undefined` unsets the variable, which `Object.assign` cannot express: it would
 * store the string "undefined" instead.
 */
const applyEnv = (vars) => {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const set = (entries) => {
    for (const [key, value] of entries) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  set(Object.entries(vars));
  return () => set(Object.entries(saved));
};

/** Runs `fn` with `vars` applied to the environment, restoring whatever was there before. */
export const withEnv = (vars, fn) => {
  const restore = applyEnv(vars);
  try {
    return fn();
  } finally {
    restore();
  }
};

/** Applies `vars` for the rest of a `node:test` case, restoring them when the test ends. */
export const setEnv = (t, vars) => t.after(applyEnv(vars));

/**
 * A stand-in for the Anthropic API that records every message body it receives, serves
 * `catalog` as its model list, and closes when the test ends. Returns the bodies seen so far
 * and the URL to point the proxy at.
 */
export async function captureUpstream(t, { catalog = [] } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/v1/models")) return res.end(JSON.stringify({ data: catalog }));
      seen.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.end('{"id":"msg_1","type":"message"}');
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { seen, url: `http://127.0.0.1:${server.address().port}` };
}
