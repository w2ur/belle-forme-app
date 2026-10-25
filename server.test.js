// @vitest-environment node
/**
 * server.mjs, exercised over a real socket: what a self-hoster gets must be what
 * netlify.toml and the two Netlify runtimes give — the static build with its
 * SPA fallback and headers, the Lambda functions, and the coach's stream piped
 * chunk by chunk.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { Writable } from "node:stream";
import fc from "fast-check";
import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The sync functions read Neon through getDb; a tagged-template stub that
// answers every query with no rows stands in for the database.
vi.mock("./netlify/functions/lib/db.js", async (importOriginal) => {
  const real = await importOriginal();
  const sql = async () => [];
  return { ...real, getDb: () => sql };
});

const {
  createApp, createHttpServer, loadHandlers, resolveStatic, pipeWebResponse, parseTrustedProxies, normalizeHop,
  clientAddress, listenAddress, SECURITY_HEADERS, MAX_BODY_BYTES,
} = await import("./server.mjs");
const { clientIp } = await import("./netlify/functions/lib/loginThrottle.js");

const PASSPHRASE = "test passphrase only";
const SYNC_KEY = "test-sync-key";

let tmp;
let distDir;

async function listen(app) {
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** A raw GET, so the path reaches the server byte for byte (fetch normalises `..`). */
function rawGet(base, rawPath) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: rawPath, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "bf-server-"));
  distDir = path.join(tmp, "dist");
  mkdirSync(path.join(distDir, "assets"), { recursive: true });
  writeFileSync(path.join(distDir, "index.html"), "<!doctype html><title>app shell</title>");
  writeFileSync(path.join(distDir, "assets", "app-abc123.js"), "console.log('app')");
  writeFileSync(path.join(distDir, "manifest.webmanifest"), "{}");
  mkdirSync(path.join(distDir, "demo"), { recursive: true });
  writeFileSync(path.join(distDir, "demo", "index.html"), "<!doctype html><title>demo shell</title>");
  writeFileSync(path.join(tmp, "secret.txt"), "OUTSIDE DIST");
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("static files", () => {
  let server;
  let base;
  beforeAll(async () => ({ server, base } = await listen(createApp({ distDir, handlers: {} }))));
  afterAll(() => server.close());

  it("serves a real file with its content type, the three headers and a long cache on hashed assets", async () => {
    const res = await fetch(`${base}/assets/app-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toContain("immutable");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(name)).toBe(value);
    expect(await res.text()).toBe("console.log('app')");
  });

  it("gives the manifest its own type", async () => {
    const res = await fetch(`${base}/manifest.webmanifest`);
    expect(res.headers.get("content-type")).toMatch(/^application\/manifest\+json/);
  });

  it("falls back to index.html, 200, for any app route", async () => {
    for (const route of ["/", "/coach", "/deep/link/42"]) {
      const res = await fetch(`${base}${route}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(await res.text()).toContain("app shell");
    }
  });

  it("answers /demo routes with the demo's own shell, never the real app's", async () => {
    for (const route of ["/demo", "/demo/", "/demo/coach"]) {
      const res = await fetch(`${base}${route}`);
      expect(res.status, route).toBe(200);
      expect(await res.text(), route).toContain("demo shell");
    }
    expect(await (await fetch(`${base}/demonstration`)).text()).toContain("app shell");
  });

  it("refuses to read outside dist/", async () => {
    for (const p of ["/../secret.txt", "/..%2fsecret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/%2e%2e%5csecret.txt", "/a%00b"]) {
      const res = await rawGet(base, p);
      expect(res.body, p).not.toContain("OUTSIDE DIST");
    }
    expect(resolveStatic(distDir, "/..%2fsecret.txt")).toBeNull();
    expect(resolveStatic(distDir, "/%E0%A4%A")).toBeNull(); // malformed escape
    expect(resolveStatic(distDir, "/assets/app-abc123.js")).toBe(path.join(distDir, "assets", "app-abc123.js"));
  });

  it("answers an unknown /api path with a JSON 404, never the app shell", async () => {
    for (const p of ["/api/nope", "/api/", "/api/lib", "/api/__proto__"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status, p).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    }
  });
});

describe("the real Netlify functions", () => {
  let server;
  let base;
  const saved = {};
  beforeAll(async () => {
    for (const k of ["APP_PASSWORD_HASH", "SYNC_API_KEY"]) saved[k] = process.env[k];
    process.env.APP_PASSWORD_HASH = crypto.createHash("sha256").update(PASSPHRASE).digest("hex");
    process.env.SYNC_API_KEY = SYNC_KEY;
    ({ server, base } = await listen(createApp({ distDir, handlers: await loadHandlers() })));
  });
  afterAll(() => {
    server.close();
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });

  it("loads every Lambda function and the coach under its declared path", async () => {
    const { lambdas, web } = await loadHandlers();
    expect(Object.keys(lambdas)).toEqual(expect.arrayContaining(["login", "sync-pull", "sync-sessions", "sync-export"]));
    expect(Object.keys(web)).toEqual(["/api/coach-chat"]);
  });

  it("login: the right passphrase returns the sync key, a wrong one 401", async () => {
    const good = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ password: PASSPHRASE }) });
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ key: SYNC_KEY });
    const bad = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ password: "nope" }) });
    expect(bad.status).toBe(401);
    const get = await fetch(`${base}/api/login`);
    expect(get.status).toBe(405);
  });

  it("sync-pull: the key opens it, its absence is a 401", async () => {
    const res = await fetch(`${base}/api/sync-pull`, { headers: { Authorization: `Bearer ${SYNC_KEY}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toMatchObject({ sessions: [], plan: null, catalog: null });
    expect((await fetch(`${base}/api/sync-pull`)).status).toBe(401);
  });

  it("the coach refuses a request without the key (the real edge function, under Node)", async () => {
    const res = await fetch(`${base}/api/coach-chat`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("refuses a body larger than a Netlify function would take", async () => {
    const res = await fetch(`${base}/api/login`, { method: "POST", body: "x".repeat(MAX_BODY_BYTES + 1) });
    expect(res.status).toBe(413);
  });
});

describe("a streamed Web handler", () => {
  let server;
  afterEach(() => server?.close());

  /** A handler whose second chunk waits for `release()` — which the test calls only once the first chunk has ARRIVED. */
  function gatedHandler() {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const cancelled = vi.fn();
    const seen = {};
    const handler = async (req) => {
      seen.method = req.method;
      seen.body = await req.text();
      seen.auth = req.headers.get("authorization");
      const enc = new TextEncoder();
      return new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(enc.encode("first "));
          await gate;
          try { controller.enqueue(enc.encode("second")); controller.close(); } catch { /* cancelled */ }
        },
        cancel: cancelled,
      }), { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    };
    return { handler, release, cancelled, seen };
  }

  it("delivers each chunk as it is produced, before the stream ends", async () => {
    const stub = gatedHandler();
    let base;
    ({ server, base } = await listen(createApp({ distDir, handlers: { web: { "/api/coach-chat": stub.handler } } })));
    const res = await fetch(`${base}/api/coach-chat`, { method: "POST", headers: { Authorization: "Bearer k" }, body: '{"message":"hi"}' });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    // If the server buffered the body, this read would wait for a stream that
    // cannot end until we release it: the timeout turns that deadlock into a failure.
    const first = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("first chunk not delivered before the stream ended")), 2000)),
    ]);
    expect(dec.decode(first.value)).toBe("first ");
    stub.release();
    let rest = "";
    for (;;) { const { done, value } = await reader.read(); if (done) break; rest += dec.decode(value); }
    expect(rest).toBe("second");
    expect(stub.seen).toEqual({ method: "POST", body: '{"message":"hi"}', auth: "Bearer k" });
  });

  it("cancels the handler's stream when the client goes away", async () => {
    const stub = gatedHandler();
    let base;
    ({ server, base } = await listen(createApp({ distDir, handlers: { web: { "/api/coach-chat": stub.handler } } })));
    const ac = new AbortController();
    const res = await fetch(`${base}/api/coach-chat`, { method: "POST", body: "{}", signal: ac.signal });
    await res.body.getReader().read();
    ac.abort();
    await vi.waitFor(() => expect(stub.cancelled).toHaveBeenCalled(), { timeout: 2000 });
    stub.release();
  });

  // The receive timeouts scaled down 100x: a reply that streams, and goes
  // silent, for longer than both must still arrive whole.
  it("a stream outlasting headersTimeout and requestTimeout, with a long silence, is not cut", async () => {
    const enc = new TextEncoder();
    const slow = async () => new Response(new ReadableStream({
      async start(controller) {
        for (const [part, pause] of [["a", 100], ["b", 900], ["c", 100]]) {
          await new Promise((r) => setTimeout(r, pause));
          controller.enqueue(enc.encode(part));
        }
        controller.close();
      },
    }));
    server = createHttpServer(
      createApp({ distDir, handlers: { web: { "/api/coach-chat": slow } } }),
      { headersTimeout: 300, requestTimeout: 400, connectionsCheckingInterval: 50 },
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/coach-chat`, { method: "POST", body: "{}" });
    expect(await res.text()).toBe("abc");
    expect(server.timeout).toBe(0); // Node's default: no socket inactivity cut-off
  });

  // The control for the test above: the same scaled-down server still cuts a
  // client that trickles its request body in. Without it, "the stream was not
  // cut" could just mean no timeout was armed at all.
  it("control: under the same options, a slowly sent body gets a 408", async () => {
    const hang = vi.fn(async () => new Response("never"));
    server = createHttpServer(
      createApp({ distDir, handlers: { web: { "/api/coach-chat": hang } } }),
      { headersTimeout: 300, requestTimeout: 400, connectionsCheckingInterval: 50 },
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const reply = await new Promise((resolve, reject) => {
      const socket = net.connect(server.address().port, "127.0.0.1", () => {
        socket.write("POST /api/coach-chat HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n");
        const tick = setInterval(() => { if (!socket.destroyed) socket.write("x"); }, 100);
        let data = "";
        socket.on("data", (c) => { data += c; });
        socket.on("close", () => { clearInterval(tick); resolve(data); });
        socket.on("error", () => {});
        setTimeout(() => { clearInterval(tick); reject(new Error("no answer within 3 s")); }, 3000);
      });
    });
    expect(reply).toMatch(/^HTTP\/1\.1 408/);
    expect(hang).not.toHaveBeenCalled();
  });

  it("keeps idle connections longer than a reverse proxy reuses them; headersTimeout stays Node's", () => {
    const s = createHttpServer(() => {});
    expect(s.keepAliveTimeout).toBe(125_000);
    expect(s.headersTimeout).toBe(60_000); // Node's default
    expect(s.requestTimeout).toBe(300_000); // Node's default
  });

  // Why headersTimeout need not exceed keepAliveTimeout on Node 24: the headers
  // clock starts when a request starts arriving, not while the connection sits
  // idle. Scaled down: idle 1.5 s on a kept-alive socket with a 300 ms
  // headersTimeout, then a second request on it still gets its 200. (Node 24
  // adds a 1 s buffer to keepAliveTimeout, hence the margins.)
  it("a kept-alive connection idle past headersTimeout still serves its next request", async () => {
    server = createHttpServer(
      createApp({ distDir, handlers: {} }),
      { keepAliveTimeout: 3000, headersTimeout: 300, requestTimeout: 400, connectionsCheckingInterval: 50 },
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const statuses = await new Promise((resolve, reject) => {
      const socket = net.connect(server.address().port, "127.0.0.1");
      let data = "";
      const ask = () => socket.write("GET /assets/app-abc123.js HTTP/1.1\r\nHost: x\r\n\r\n");
      socket.on("connect", ask);
      socket.on("data", (c) => {
        data += c;
        const seen = data.match(/HTTP\/1\.1 \d{3}/g) ?? [];
        if (seen.length === 1 && !socket.asked) { socket.asked = true; setTimeout(ask, 1500); }
        if (seen.length === 2) { socket.destroy(); resolve(seen); }
      });
      socket.on("close", () => resolve(data.match(/HTTP\/1\.1 \d{3}/g) ?? []));
      socket.on("error", reject);
    });
    expect(statuses).toEqual(["HTTP/1.1 200", "HTTP/1.1 200"]);
  });
});

// Regression, self-hosting 2026-10-25: the server is the edge off Netlify. It
// drops every client-sent x-nf-* header and writes x-nf-client-connection-ip
// itself, so the login throttle buckets on a real address: with no proxy every
// caller used to share one bucket, and a forged header could pick its own.
describe("the client address the server stamps", () => {
  let server;
  afterEach(() => server?.close());

  async function seenBy(trusted, headers) {
    const seen = {};
    const handlers = {
      lambdas: { echo: async (event) => { seen.lambda = event.headers; return { statusCode: 200, body: "{}" }; } },
      web: { "/api/stream": async (req) => { seen.web = Object.fromEntries(req.headers); return new Response("ok"); } },
    };
    let base;
    ({ server, base } = await listen(createApp({ distDir, handlers, trusted })));
    await fetch(`${base}/api/echo`, { headers });
    await (await fetch(`${base}/api/stream`, { headers })).text();
    return seen;
  }

  it("a direct connection buckets on the socket address, and forged x-nf-* headers are overwritten or dropped", async () => {
    const seen = await seenBy(null, { "X-Nf-Client-Connection-Ip": "198.51.100.1", "x-nf-request-id": "forged", "x-forwarded-for": "198.51.100.2" });
    for (const h of [seen.lambda, seen.web]) {
      expect(clientIp(h)).toBe("127.0.0.1"); // ::ffff:127.0.0.1 is the IPv4 client
      expect(h["x-nf-request-id"]).toBeUndefined();
      expect(h["x-forwarded-for"]).toBe("198.51.100.2"); // passed through, not trusted
    }
  });

  // The test client connects from 127.0.0.1, so naming it makes it the proxy.
  it("when the peer is the trusted proxy, the RIGHTMOST hop decides", async () => {
    const seen = await seenBy(parseTrustedProxies("127.0.0.1"), { "x-forwarded-for": "198.51.100.66, 203.0.113.9", "X-Nf-Client-Connection-Ip": "198.51.100.1" });
    expect(clientIp(seen.lambda)).toBe("203.0.113.9");
    expect(clientIp(seen.web)).toBe("203.0.113.9");
  });

  // Regression, review round 2: TRUST_PROXY=1 trusted X-Forwarded-For from ANY
  // peer, so a client reaching the port directly could still pick its bucket.
  it("a peer that is not the proxy has its X-Forwarded-For ignored", async () => {
    const seen = await seenBy(parseTrustedProxies("10.0.0.1, 192.168.0.0/16"), { "x-forwarded-for": "198.51.100.66, 203.0.113.9" });
    expect(clientIp(seen.lambda)).toBe("127.0.0.1");
  });

  it("a trusted proxy that sent no X-Forwarded-For falls back to the socket", async () => {
    const seen = await seenBy(parseTrustedProxies("127.0.0.1"), {});
    expect(clientIp(seen.lambda)).toBe("127.0.0.1");
  });
});

// Regression, code review 2026-10-25: a backed-up response waited on `drain`
// alone, and a client that left while it was backed up never drains — the pipe
// hung for good and never reached its `finally`.
describe("pipeWebResponse on a backed-up, abandoned response", () => {
  /** A Node response stand-in whose writes never complete until released. */
  class FullResponse extends Writable {
    constructor() {
      super({ highWaterMark: 1 });
      this.pending = [];
      this.writes = 0;
    }
    _write(_chunk, _enc, done) { this.writes++; this.pending.push(done); }
    release() { const p = this.pending; this.pending = []; for (const done of p) done(); }
    writeHead() {}
    flushHeaders() {}
  }

  const endless = () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array(1024)), cancel });
    return { response: new Response(body), cancel };
  };
  const within = (p, ms) => Promise.race([p.then(() => "done"), new Promise((r) => setTimeout(() => r("hung"), ms))]);

  it("exits when the client closes while it waits for drain, and cancels the source", async () => {
    const res = new FullResponse();
    const { response, cancel } = endless();
    const piping = pipeWebResponse(response, res);
    await new Promise((r) => setTimeout(r, 20)); // now parked on the full buffer
    res.destroy();
    expect(await within(piping, 1000)).toBe("done");
    expect(res.destroyed).toBe(true);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled(), { timeout: 1000 });
  });

  it("exits on a socket error too, and cancels the source", async () => {
    const res = new FullResponse();
    res.on("error", () => {});
    const { response, cancel } = endless();
    const piping = pipeWebResponse(response, res);
    await new Promise((r) => setTimeout(r, 20));
    res.destroy(new Error("EPIPE"));
    expect(await within(piping, 1000)).toBe("done");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled(), { timeout: 1000 });
  });

  it("control: a drain resumes the pipe rather than ending it", async () => {
    const res = new FullResponse();
    const piping = pipeWebResponse(endless().response, res);
    await new Promise((r) => setTimeout(r, 20));
    const before = res.writes;
    expect(before).toBeGreaterThan(0);
    res.release();
    await new Promise((r) => setTimeout(r, 20));
    expect(res.writes).toBeGreaterThan(before);
    res.destroy();
    await piping;
  });
});

describe("TRUST_PROXY", () => {
  it("matches IPs and CIDRs, IPv4-mapped IPv6 peers included", () => {
    const trusted = parseTrustedProxies(" 127.0.0.1 , 172.16.0.0/12, 2001:db8::/32 ");
    for (const peer of ["127.0.0.1", "::ffff:127.0.0.1", "172.18.0.5", "::ffff:172.31.255.1", "2001:db8::7"]) expect(trusted(peer), peer).toBe(true);
    for (const peer of ["127.0.0.2", "172.32.0.1", "::ffff:10.0.0.1", "2001:db9::1", "", undefined]) expect(trusted(peer), String(peer)).toBe(false);
  });

  it("unset or blank trusts nobody", () => {
    expect(parseTrustedProxies(undefined)).toBeNull();
    expect(parseTrustedProxies("  ")).toBeNull();
  });

  // Regression, review round 2: `1` meant "trust any peer". It is refused, not aliased.
  it("refuses TRUST_PROXY=1 and anything that is not an address, with a message that says what to write", () => {
    expect(() => parseTrustedProxies("1")).toThrow(/no longer accepted.*name the proxy/);
    for (const bad of ["true", "127.0.0.1/33", "10.0.0.0/8/1", "proxy.local", "127.0.0.1,"]) {
      expect(() => parseTrustedProxies(bad), bad).toThrow(/IPs or CIDRs/);
    }
  });
});

describe("normalizeHop", () => {
  it("strips a port, unwraps a bracketed IPv6, and keeps a bare address", () => {
    expect(normalizeHop(" 203.0.113.9:4711 ")).toBe("203.0.113.9");
    expect(normalizeHop("[2001:db8::1]:4711")).toBe("2001:db8::1");
    expect(normalizeHop("[2001:db8::1]")).toBe("2001:db8::1");
    expect(normalizeHop("2001:db8::1")).toBe("2001:db8::1");
    expect(normalizeHop("203.0.113.9")).toBe("203.0.113.9");
  });

  // Regression, review round 2: the hop was taken verbatim, so "unknown" or a
  // port-suffixed entry became a bucket of its own.
  it("anything that is not an IP makes the server fall back to the socket", () => {
    for (const bad of ["unknown", "", "203.0.113.9:x", "_hidden", "[nope]:1"]) expect(normalizeHop(bad), bad).toBeNull();
    const req = (xff) => ({ headers: { "x-forwarded-for": xff }, socket: { remoteAddress: "127.0.0.1" } });
    const trusted = parseTrustedProxies("127.0.0.1");
    expect(clientAddress(req("198.51.100.1, unknown"), trusted)).toBe("127.0.0.1");
    expect(clientAddress(req("198.51.100.1, 203.0.113.9:4711"), trusted)).toBe("203.0.113.9");
  });
});

// Review round 2: listen() with no host bound every interface, so `npm start`
// put plain HTTP carrying the passphrase on the network.
describe("listenAddress", () => {
  it("is loopback on port 8888 by default", () => {
    expect(listenAddress({})).toEqual({ host: "127.0.0.1", port: 8888 });
  });

  it("follows HOST and PORT", () => {
    expect(listenAddress({ HOST: "0.0.0.0", PORT: "3000" })).toEqual({ host: "0.0.0.0", port: 3000 });
    expect(listenAddress({ HOST: "  " })).toEqual({ host: "127.0.0.1", port: 8888 });
  });
});

// Review round 2: a client that hung up mid-body was logged as a server error
// with its stack trace, and answered with a 500 on a dead socket.
describe("a client that leaves while sending its body", () => {
  it("is not an error: nothing logged, no 500 attempted", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = vi.fn(async () => ({ statusCode: 200, body: "{}" }));
    const app = createApp({ distDir, handlers: { lambdas: { login: handler } } });
    const writes = [];
    const server = createHttpServer(async (req, res) => {
      const writeHead = res.writeHead.bind(res);
      res.writeHead = (status, ...rest) => { writes.push(status); return writeHead(status, ...rest); };
      await app(req, res);
      server.emit("handled");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const handled = once(server, "handled");
      const socket = net.connect(server.address().port, "127.0.0.1", () => {
        socket.write("POST /api/login HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nhello");
        setTimeout(() => socket.destroy(), 50);
      });
      socket.on("error", () => {});
      await handled;
      expect(handler).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      server.close();
    }
  });
});

// Regression, review round 3: `Number("")` is 0, so "10.0.0.1/" was read as
// 10.0.0.1/0 — every IPv4 peer trusted. A prefix must be digits, and none may
// be so broad that it trusts most of the internet.
describe("TRUST_PROXY prefixes", () => {
  it("refuses an empty, non-numeric, zero or over-broad prefix", () => {
    for (const bad of ["10.0.0.1/", "10.0.0.0/+8", "10.0.0.0/8.0", "10.0.0.0/ 8", "10.0.0.0/0x8", "10.0.0.0/0008"]) {
      expect(() => parseTrustedProxies(bad), bad).toThrow(/IPs or CIDRs/);
    }
    for (const broad of ["0.0.0.0/0", "10.0.0.0/7", "2000::/6"]) {
      expect(() => parseTrustedProxies(broad), broad).toThrow(/too broad/);
    }
  });

  it("control: the narrowest allowed prefixes are accepted", () => {
    expect(parseTrustedProxies("10.0.0.0/8")("10.200.0.1")).toBe(true);
    expect(parseTrustedProxies("2001:db8::/16")("2001:ffff::1")).toBe(true);
    expect(parseTrustedProxies("172.28.0.0/16, 127.0.0.1/32")("172.28.0.1")).toBe(true);
  });
});

// Review rounds 3–4: compose pins its gateway to 10.203.0.1 so a host proxy can
// be named by one address. Its connections reach the app from that gateway, as
// a plain IPv4 peer (server.mjs listens on 0.0.0.0 in the container); two
// clients behind it must land in two buckets, and docker-smoke checks the same
// through the real stack.
describe("behind compose's pinned gateway", () => {
  it("two forwarded clients get two addresses; a peer outside the range does not", () => {
    const trusted = parseTrustedProxies("10.203.0.1");
    const via = (peer, xff) => clientAddress({ headers: { "x-forwarded-for": xff }, socket: { remoteAddress: peer } }, trusted);
    const a = via("10.203.0.1", "198.51.100.1");
    const b = via("10.203.0.1", "198.51.100.2");
    expect([a, b]).toEqual(["198.51.100.1", "198.51.100.2"]);
    expect(clientIp({ "x-nf-client-connection-ip": a })).not.toBe(clientIp({ "x-nf-client-connection-ip": b }));
    expect(via("10.203.0.2", "198.51.100.1")).toBe("10.203.0.2"); // another container on the same network
  });
});

// Regression, review round 3: tcsh exports HOST as the machine's hostname, and
// a hostname may resolve to a public interface. HOST must be an IP literal.
describe("listenAddress HOST validation", () => {
  it("refuses a hostname or anything else that is not an IP, saying what to write", () => {
    for (const bad of ["my-laptop.local", "localhost", "0.0.0.0:8888", "*", "1"]) {
      expect(() => listenAddress({ HOST: bad }), bad).toThrow(/HOST must be an IP address/);
    }
  });

  it("control: IPv4 and IPv6 literals are accepted", () => {
    expect(listenAddress({ HOST: "::1" }).host).toBe("::1");
    expect(listenAddress({ HOST: " 192.168.1.10 " }).host).toBe("192.168.1.10");
  });
});

// Regression, review round 4: an IPv6 entry covering ::ffff:0:0/96 matches
// IPv4 peers through their mapped form — "::/16" passed the /16 floor and
// trusted every IPv4 address on the internet, 8.8.8.8 included.
describe("TRUST_PROXY and IPv4-mapped IPv6", () => {
  it("refuses any IPv6 entry overlapping ::ffff:0:0/96, whatever its spelling", () => {
    for (const bad of ["::ffff:0:0/96", "::/16", "::ffff:0.0.0.0/96", "::ffff:8.8.8.8", "::ffff:808:808", "::/7", "0:0:0:0:0:ffff::/100"]) {
      expect(() => parseTrustedProxies(bad), bad).toThrow(/IPv4-mapped/);
    }
  });

  it("accepts unique-local ranges down to /7", () => {
    expect(parseTrustedProxies("fd00::/8")("fd12::1")).toBe(true);
    expect(parseTrustedProxies("fc00::/7")("fdff::1")).toBe(true);
    expect(() => parseTrustedProxies("fc00::/6")).toThrow(/too broad/);
  });

  it("no accepted IPv6 entry ever matches an IPv4 peer", () => {
    // Biased towards 0 and ffff, or the mapped range (80 zero bits, then ffff)
    // would almost never be drawn.
    const hex = fc.oneof(fc.constant("0"), fc.constant("ffff"), fc.integer({ min: 0, max: 0xffff }).map((n) => n.toString(16)));
    const entry = fc.tuple(fc.array(hex, { minLength: 8, maxLength: 8 }), fc.integer({ min: 0, max: 128 }))
      .map(([groups, prefix]) => `${groups.join(":")}/${prefix}`);
    fc.assert(fc.property(entry, (e) => {
      let trusted;
      try { trusted = parseTrustedProxies(e); } catch { return true; } // refused is fine
      return !trusted("8.8.8.8") && !trusted("::ffff:8.8.8.8") && !trusted("10.203.0.1");
    }), { numRuns: 2000 });
  });

  it("control: an IPv4 entry that covers 8.8.8.8 does match it", () => {
    expect(parseTrustedProxies("8.8.8.0/24")("8.8.8.8")).toBe(true);
    expect(parseTrustedProxies("8.8.8.0/24")("::ffff:8.8.8.8")).toBe(true);
  });
});

// Review round 4: `Number(env.PORT) || 8888` turned a typo into a silent 8888
// ("80a", "0") or a crash deep in listen() ("70000", "-1").
describe("listenAddress PORT validation", () => {
  it("refuses anything but an integer from 1 to 65535, saying what to write", () => {
    for (const bad of ["0", "65536", "70000", "-1", "80a", "8.5", "0x50", "1e3", "abc"]) {
      expect(() => listenAddress({ PORT: bad }), bad).toThrow(/PORT must be a whole number from 1 to 65535/);
    }
  });

  it("control: 1, 65535 and an unset or blank PORT (8888) are accepted", () => {
    expect(listenAddress({ PORT: "1" }).port).toBe(1);
    expect(listenAddress({ PORT: " 65535 " }).port).toBe(65535);
    expect(listenAddress({}).port).toBe(8888);
    expect(listenAddress({ PORT: "" }).port).toBe(8888);
  });
});
