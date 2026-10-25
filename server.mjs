// Self-hosted runtime: the same app Netlify serves, on plain Node, with no
// dependency beyond what the functions already import.
//
//   npm run build && npm start        # 127.0.0.1:8888 by default (HOST, PORT)
//
// It reproduces exactly what netlify.toml and the Netlify runtimes provide:
// - the static build in dist/, with the SPA fallback to /index.html and the
//   three security headers;
// - `/api/<name>` → `netlify/functions/<name>.js`, a Lambda-v1 `handler(event)`;
// - every edge function under its own `config.path` (the coach, at
//   /api/coach-chat), a Web `(Request) => Response` whose body is PIPED chunk by
//   chunk, never buffered: the coach streams for up to a minute, and a buffered
//   reply would arrive all at once at the end, or not at all behind a proxy
//   timeout.
//
// Secrets are read by the functions themselves through lib/env.js, which falls
// back to process.env off Netlify.
import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import net from "node:net";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** The `[[headers]] for = "/*"` block of netlify.toml, on every response. */
export const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

/** Netlify's own request-body ceiling for a function. */
export const MAX_BODY_BYTES = 6 * 1024 * 1024;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export const contentTypeFor = (file) =>
  CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";

/**
 * Imports the handlers from netlify/: every top-level `functions/*.js` exporting
 * `handler` (keyed by file name) and every `edge-functions/*.js` exporting a
 * default function and a `config.path` (keyed by that path).
 */
export async function loadHandlers(netlifyDir = path.join(ROOT, "netlify")) {
  const lambdas = {};
  const web = {};
  for (const [dir, register] of [
    ["functions", (name, mod) => { if (typeof mod.handler === "function") lambdas[name] = mod.handler; }],
    ["edge-functions", (_name, mod) => {
      if (typeof mod.default === "function" && typeof mod.config?.path === "string") web[mod.config.path] = mod.default;
    }],
  ]) {
    const full = path.join(netlifyDir, dir);
    const files = (await readdir(full, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith(".js"));
    for (const file of files) {
      register(file.name.slice(0, -3), await import(pathToFileURL(path.join(full, file.name)).href));
    }
  }
  return { lambdas, web };
}

/** Connection-level headers that describe the Node socket, not the request a handler sees. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "expect"]);

class BodyTooLarge extends Error {}

/** The client hung up before its request was in: ordinary, not a server error. */
class ClientGone extends Error {}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
      chunks.push(chunk);
    }
  } catch (e) {
    if (e instanceof BodyTooLarge) throw e;
    // A request stream errors with "aborted" (code ECONNRESET) when the socket
    // closes mid-body; there is nobody left to answer.
    if (e?.code === "ECONNRESET" || e?.message === "aborted" || req.destroyed) throw new ClientGone();
    throw e;
  }
  return Buffer.concat(chunks);
}

/**
 * The broadest prefixes TRUST_PROXY accepts: a proxy is a host or a private
 * network. /7 for IPv6 is the unique-local block, fc00::/7.
 */
const MIN_PREFIX_V4 = 8;
const MIN_PREFIX_V6 = 7;

/** An IPv6 literal (dotted IPv4 tail allowed) as a 128-bit BigInt. */
function ipv6ToBigInt(address) {
  let text = address.toLowerCase();
  const tail = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    text = text.slice(0, -tail[0].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, rest] = text.split("::");
  const h = head ? head.split(":") : [];
  const r = rest === undefined ? [] : rest ? rest.split(":") : [];
  const groups = rest === undefined ? h : [...h, ...Array(8 - h.length - r.length).fill("0"), ...r];
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

const MAPPED_V4 = 0xffffn << 32n; // ::ffff:0:0/96

/**
 * Whether `address/prefix` shares any address with ::ffff:0:0/96, the block
 * through which an IPv6 entry matches IPv4 peers (net.BlockList maps them).
 * Two prefixes overlap when they agree on the shorter one's bits.
 */
function overlapsMappedV4(address, prefix) {
  const bits = BigInt(Math.min(prefix, 96));
  const shift = 128n - bits;
  return (ipv6ToBigInt(address) >> shift) === (MAPPED_V4 >> shift);
}

/**
 * `TRUST_PROXY` → a predicate on the socket peer, or null when unset.
 *
 * The variable NAMES the reverse proxy: a comma-separated list of IPs or CIDRs
 * (`127.0.0.1`, `10.203.0.1`, `10.0.0.0/8`, `::1`), each prefix digits only and no broader
 * than /8 (IPv4) or /7 (IPv6, the unique-local block); an IPv6 entry may not
 * reach into ::ffff:0:0/96. A bare `1` is refused rather than
 * read as "trust whoever connects": that would let any client that reaches the
 * port directly write its own address into `X-Forwarded-For`. IPv4-mapped IPv6
 * peers (`::ffff:172.18.0.5`) match their IPv4 entries (net.BlockList).
 * Throws on anything it cannot read, so a typo stops the server at startup.
 */
export function parseTrustedProxies(value) {
  if (value == null || !String(value).trim()) return null;
  const list = new net.BlockList();
  for (const raw of String(value).split(",")) {
    const entry = raw.trim();
    const [address, bits, extra] = entry.split("/");
    const family = net.isIP(address);
    // Digits only: `Number("")` is 0, and "10.0.0.1/" once read as /0.
    const prefix = bits === undefined ? null : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
    const max = family === 6 ? 128 : 32;
    if (!family || extra !== undefined || Number.isNaN(prefix) || (prefix !== null && prefix > max)) {
      throw new Error(
        `TRUST_PROXY must list your reverse proxy's address(es), as IPs or CIDRs separated by commas (e.g. 127.0.0.1 or 10.203.0.1); "${entry}" is not one.`
        + (entry === "1" ? " TRUST_PROXY=1 is no longer accepted: name the proxy instead." : ""),
      );
    }
    // A proxy is one machine or one private network, never most of the
    // internet: /0 trusts every peer, which is what `TRUST_PROXY=1` did.
    const min = family === 6 ? MIN_PREFIX_V6 : MIN_PREFIX_V4;
    if (prefix !== null && prefix < min) {
      throw new Error(`TRUST_PROXY entry "${entry}" is too broad: the prefix must be at least /${min} for IPv${family}. Name your proxy's address or its private network.`);
    }
    // An IPv6 entry reaching into the IPv4-mapped block would trust IPv4 peers
    // with no IPv4 floor at all ("::/16" trusted 8.8.8.8). IPv4 proxies are
    // written in IPv4 form.
    if (family === 6 && overlapsMappedV4(address, prefix ?? 128)) {
      throw new Error(`TRUST_PROXY entry "${entry}" covers IPv4-mapped addresses (::ffff:0:0/96): write an IPv4 proxy in IPv4 form, e.g. 10.203.0.1.`);
    }
    const type = family === 6 ? "ipv6" : "ipv4";
    if (prefix === null) list.addAddress(address, type);
    else list.addSubnet(address, prefix, type);
  }
  return (peer) => {
    const family = net.isIP(peer ?? "");
    return family !== 0 && list.check(peer, family === 6 ? "ipv6" : "ipv4");
  };
}

/**
 * One `X-Forwarded-For` entry as a bare IP, or null. Proxies may write a port
 * (`203.0.113.9:4711`, `[2001:db8::1]:4711`); anything that is still not an IP
 * after that is not an address.
 */
export function normalizeHop(hop) {
  let h = String(hop ?? "").trim();
  const bracketed = h.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) h = bracketed[1];
  else if (/^[\d.]+:\d+$/.test(h)) h = h.slice(0, h.lastIndexOf(":"));
  return net.isIP(h) ? h : null;
}

/**
 * The client address this server vouches for — the job Netlify's edge does in
 * production. The socket's peer, unless that peer IS a trusted proxy
 * (`trusted`, from `TRUST_PROXY`): then the RIGHTMOST `X-Forwarded-For` hop,
 * the one that proxy appended — everything to its left came from the client.
 * A hop that is not an IP falls back to the peer.
 */
export function clientAddress(req, trusted) {
  const peer = req.socket?.remoteAddress ?? "";
  if (trusted && trusted(peer)) {
    const hop = normalizeHop((req.headers["x-forwarded-for"] ?? "").split(",").at(-1));
    if (hop) return hop;
  }
  return peer;
}

/**
 * Node's header object, folded to single strings the way a Lambda event carries
 * them, with the edge's headers rewritten as Netlify's edge would.
 *
 * Every client-sent `x-nf-*` header is DROPPED, then `x-nf-client-connection-ip`
 * is written from `clientAddress`. The SAME header name, not one of our own,
 * on purpose: the login throttle then has one source of truth whatever the host
 * (on Netlify only the edge can set it, here only this server can), and nothing
 * in the functions has to guess which runtime it is in.
 */
function flatHeaders(req, trusted) {
  const out = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.startsWith("x-nf-")) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  const address = clientAddress(req, trusted);
  if (address) out["x-nf-client-connection-ip"] = address;
  return out;
}

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

const sendJson = (res, status, data) =>
  send(res, status, { "Content-Type": "application/json" }, JSON.stringify(data));

async function runLambda(handler, req, res, url, body, trusted) {
  const event = {
    httpMethod: req.method,
    headers: flatHeaders(req, trusted),
    body: body.length ? body.toString("utf8") : null,
    isBase64Encoded: false,
    path: url.pathname,
    queryStringParameters: Object.fromEntries(url.searchParams),
  };
  const result = (await handler(event)) ?? {};
  const payload = result.isBase64Encoded ? Buffer.from(result.body ?? "", "base64") : (result.body ?? "");
  send(res, result.statusCode ?? 200, result.headers ?? {}, payload);
}

/**
 * Pipes a Web Response to the Node response chunk by chunk, with backpressure,
 * through `stream.pipeline`: it waits for drain, ends the response, and when
 * the client goes away (or the socket errors) destroys the source — and
 * destroying a `Readable.fromWeb` cancels the Web stream, which is what the
 * edge runtime does: the coach then stops its upstream call instead of paying
 * for a reply nobody reads.
 */
export async function pipeWebResponse(response, res) {
  const headers = { ...SECURITY_HEADERS };
  response.headers.forEach((value, name) => { headers[name] = value; });
  res.writeHead(response.status, headers);
  if (!response.body) return void res.end();
  res.flushHeaders();
  try {
    await pipeline(Readable.fromWeb(response.body), res);
  } catch {
    // The client left, or the body broke: nothing more can be sent either way.
    res.destroy();
  }
}

async function runWeb(handler, req, res, url, body, trusted) {
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const headers = new Headers();
  for (const [name, value] of Object.entries(flatHeaders(req, trusted))) {
    if (typeof value === "string" && !HOP_BY_HOP.has(name)) headers.set(name, value);
  }
  const request = new Request(url, { method: req.method, headers, body: hasBody ? body : undefined });
  await pipeWebResponse(await handler(request), res);
}

/**
 * The file under `distDir` for a URL path, or null when the path is malformed
 * or would leave `distDir` (`/..%2f..%2fetc/passwd`, an encoded NUL…).
 */
export function resolveStatic(distDir, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes("\0")) return null;
  const root = path.resolve(distDir);
  const file = path.resolve(root, "." + path.posix.normalize("/" + decoded));
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  // normalize("/" + x) can never climb above "/", so this is belt and braces:
  // a decoded segment of ".." must still not appear in what we open.
  if (decoded.split(/[\\/]/).includes("..")) return null;
  return file;
}

async function isFile(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

async function serveStatic(distDir, req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed" });
  const file = resolveStatic(distDir, url.pathname);
  if (!file) return sendJson(res, 400, { error: "Bad path" });
  // A real file wins; anything else is the SPA's route — the demo's own shell
  // under /demo (netlify.toml `/demo/*`), the real app's everywhere else (`/*`).
  const isDemo = url.pathname === "/demo" || url.pathname.startsWith("/demo/");
  const shell = path.join(path.resolve(distDir), ...(isDemo ? ["demo", "index.html"] : ["index.html"]));
  const target = (await isFile(file)) ? file : shell;
  if (!(await isFile(target))) return send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found — run `npm run build` first.");
  const rel = path.relative(path.resolve(distDir), target);
  const cache = rel.startsWith("assets" + path.sep) ? "public, max-age=31536000, immutable" : "no-cache";
  res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": contentTypeFor(target), "Cache-Control": cache });
  if (req.method === "HEAD") return void res.end();
  createReadStream(target).on("error", () => res.destroy()).pipe(res);
}

/**
 * The request listener. `handlers` comes from loadHandlers (or a test);
 * `trusted` is the reverse-proxy predicate, from `TRUST_PROXY` by default (see
 * `parseTrustedProxies`, which throws on a value it cannot read).
 */
export function createApp({ distDir = path.join(ROOT, "dist"), handlers, trusted = parseTrustedProxies(process.env.TRUST_PROXY) }) {
  const { lambdas = {}, web = {} } = handlers;
  return async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const { pathname } = url;
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        const webHandler = web[pathname];
        const name = pathname.slice("/api/".length);
        const lambda = /^[a-z0-9-]+$/.test(name) && Object.hasOwn(lambdas, name) ? lambdas[name] : null;
        if (!webHandler && !lambda) return sendJson(res, 404, { error: "Not found" });
        const body = await readBody(req);
        return webHandler ? await runWeb(webHandler, req, res, url, body, trusted) : await runLambda(lambda, req, res, url, body, trusted);
      }
      return await serveStatic(distDir, req, res, url);
    } catch (e) {
      if (e instanceof BodyTooLarge) return sendJson(res, 413, { error: "Payload too large" });
      if (e instanceof ClientGone) return void res.destroy();
      console.error("server:", e);
      if (!res.headersSent) return sendJson(res, 500, { error: "Internal error" });
      res.destroy();
    }
  };
}

/**
 * The http.Server, with one timeout set on purpose and the rest left at Node's
 * defaults.
 *
 * Kept at Node's defaults, because they cannot cut a long coach reply (Node docs,
 * `http.Server`): `requestTimeout` (300 s) bounds RECEIVING the request and
 * stops once it is in, and `server.timeout` (socket inactivity) is off. So a
 * 60 s stream, or a buffered plan emit silent for most of a minute, goes
 * through, while a client trickling its request in still gets a 408.
 *
 * Set here: `keepAliveTimeout` 125 s. A reverse proxy keeps idle upstream
 * connections open to reuse them — Caddy for 2 minutes by default, nginx's
 * upstream keepalive for 60 s — and if Node closes one first (its default is
 * 5 s), the proxy's next request on it fails with a 502. So the server must
 * hold idle connections LONGER than the longest proxy default, Caddy's 120 s.
 *
 * `headersTimeout` stays at Node's 60 s. On Node 24 its clock starts when a
 * request begins to arrive and does not run while a kept-alive connection sits
 * idle, so it need not exceed `keepAliveTimeout` (the old advice to set it
 * above dates from Node versions that counted the idle time).
 *
 * `server.test.js` streams past the receive timeouts scaled down, checks that
 * the same scaled-down server still answers a trickled body with 408, and that
 * a kept-alive connection idle past `headersTimeout` still serves its next
 * request. `options` overrides any of these (the tests shrink them).
 */
export const KEEP_ALIVE_TIMEOUT_MS = 125_000;

export function createHttpServer(listener, options = {}) {
  const { keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS, ...rest } = options;
  const server = http.createServer(rest, listener);
  server.keepAliveTimeout = keepAliveTimeout;
  return server;
}

/**
 * Where the server listens. Loopback unless `HOST` says otherwise: plain HTTP
 * carrying the passphrase must not face a network by accident, and anything
 * remote belongs behind a TLS reverse proxy on the same machine. The Docker
 * image sets `HOST=0.0.0.0` INSIDE the container; compose publishes its port on the
 * host's 127.0.0.1 only. Throws unless HOST is an IP literal and PORT a port
 * number, so a typo stops startup instead of listening somewhere unexpected.
 */
export function listenAddress(env = process.env) {
  const host = env.HOST?.trim() || "127.0.0.1";
  // An IP literal only: tcsh exports HOST as the machine's HOSTNAME, and a name
  // can resolve to a public interface — a surprise this default exists to avoid.
  if (!net.isIP(host)) {
    throw new Error(`HOST must be an IP address to listen on (127.0.0.1 by default, 0.0.0.0 for every interface); "${host}" is not one. Some shells set HOST to the machine name: unset it or set it to an IP.`);
  }
  const rawPort = env.PORT?.trim() || "8888";
  const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!(port >= 1 && port <= 65535)) {
    throw new Error(`PORT must be a whole number from 1 to 65535 (8888 by default); "${rawPort}" is not one.`);
  }
  return { host, port };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let host, port, trusted;
  try {
    ({ host, port } = listenAddress());
    trusted = parseTrustedProxies(process.env.TRUST_PROXY);
  } catch (e) {
    console.error(`belle-forme: ${e.message}`);
    process.exit(2);
  }
  const server = createHttpServer(createApp({ handlers: await loadHandlers(), trusted }));
  server.listen(port, host, () => console.log(`belle-forme: listening on http://${host}:${port}`));
  // PID 1 in a container gets no default SIGTERM handling.
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
}
