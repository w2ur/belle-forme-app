#!/usr/bin/env node
// Live probe of the Anthropic Messages API as the coach calls it, and the
// recorder of the stream fixtures its tests read. Re-run after an API change.
//
// Every request carries SYNTHETIC content only. Probe 4 builds the real plan
// schema from the live catalog (SELECT only) to prove the API accepts its enum
// and nesting; only its HTTP status is printed and its body is never saved.
// Writes go to the two recorded fixtures below and nowhere else.
//
// Usage: node scripts/anthropic-probe.mjs   (needs .env: ANTHROPIC_API_KEY, NEON_DATABASE_URL)
//
// Exit (portfolio convention): 0 every probe answered as expected and both
// fixtures were re-recorded · 1 a probe answered otherwise (a finding: the API
// changed) · 2 could not run (no key, or an auth failure) — never "healthy".
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "netlify", "__tests__", "fixtures");
const CHAT_FIXTURE = join(FIXTURES, "anthropic-chat.sse");
const EMIT_FIXTURE = join(FIXTURES, "anthropic-emit.sse");
const WRITABLE = [CHAT_FIXTURE, EMIT_FIXTURE];
try { process.loadEnvFile(join(HERE, "..", ".env")); } catch { /* env may be set already */ }
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("anthropic-probe: ANTHROPIC_API_KEY is not set");
  process.exit(2);
}
const unexpected = [];
let authFailed = false;
/** Records a probe whose status is not the one expected; 401/403 means the run could not happen at all. */
const expectStatus = (name, status, want = 200) => {
  if (status === 401 || status === 403) authFailed = true;
  if (status !== want) unexpected.push(`${name}: ${status} (expected ${want})`);
};

const { buildAnthropicRequest } = await import("../netlify/functions/lib/anthropic.js");
const { jsonSchemaResponseFormat } = await import("../netlify/functions/lib/providers.js");
const { buildPlanJsonSchema, PLAN_SCHEMA_NAME } = await import("../src/lib/planSchema.js");

const save = (path, body) => {
  if (!WRITABLE.includes(path)) throw new Error(`refusing to write ${path}`);
  writeFileSync(path, body);
};

const RULES = "Tu es un coach sportif fictif. Réponds en français, en une ou deux phrases. " +
  "Règle d'exemple : on ne programme jamais deux séances de jambes d'affilée. ".repeat(60);
const OPUS = { provider: "anthropic", model: "claude-opus-5-5", reasoningEffort: "low" };
const SONNET = { provider: "anthropic", model: "claude-sonnet-5-5", reasoningEffort: "low" };

async function send(entry, messages, opts = {}) {
  const req = buildAnthropicRequest(entry, messages, { maxTokens: 4096, ...opts });
  const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body });
  const body = await res.text();
  return { status: res.status, body };
}

const events = (sse) => sse.split("\n").filter((l) => l.startsWith("data:")).map((l) => {
  try { return JSON.parse(l.slice(5)); } catch { return null; }
}).filter(Boolean);
const startUsage = (sse) => events(sse).find((e) => e.type === "message_start")?.message?.usage ?? null;
const text = (sse) => events(sse).filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text).join("");
const log = (name, r, extra = "", want = 200) => {
  expectStatus(name, r.status, want);
  console.log(`${name}: ${r.status}${r.status === 200 ? "" : " " + r.body.slice(0, 300)} ${extra}`);
};

const chat = [
  { role: "system", content: RULES },
  { role: "user", content: "Je peux faire mes squats avec 90 secondes de repos ?" },
];

// 1. Chat, recorded.
const r1 = await send(OPUS, chat);
log("1 chat opus", r1, `types=${[...new Set(events(r1.body).map((e) => e.type))].join(",")}`);
if (r1.status === 200) save(CHAT_FIXTURE, r1.body);

// 2. Identical resend: the system block must be read from cache.
const r2 = await send(OPUS, chat);
log("2 resend", r2, `usage=${JSON.stringify(startUsage(r2.body))}`);

// 2b. The production pattern: the breakpoint moves forward one exchange.
const history = [
  { role: "system", content: RULES },
  { role: "user", content: "Bonjour, je commence une nouvelle semaine." },
  { role: "assistant", content: "Bonjour ! Dis-moi comment tu te sens aujourd'hui." },
  { role: "user", content: "En forme, un peu fatiguée hier." },
  { role: "assistant", content: "Très bien, on garde les charges de la semaine dernière." },
  { role: "user", content: "D'accord, et pour le gainage ?" },
  { role: "assistant", content: "Trois séries de trente secondes, comme prévu." },
];
const a = await send(OPUS, [...history, { role: "user", content: "Merci. Et les fentes ?" }]);
const b = await send(OPUS, [
  ...history,
  { role: "user", content: "Merci. Et les fentes ?" },
  { role: "assistant", content: "Quatre séries de dix par jambe." },
  { role: "user", content: "Et le temps de repos ?" },
]);
log("2b moving breakpoint A", a, `usage=${JSON.stringify(startUsage(a.body))}`);
log("2b moving breakpoint B", b, `usage=${JSON.stringify(startUsage(b.body))}`);

// 3. Emit with a small synthetic schema, recorded.
const small = jsonSchemaResponseFormat(PLAN_SCHEMA_NAME, buildPlanJsonSchema(["Squat", "Rowing haltères", "Pont fessier"]));
const emitMessages = [
  { role: "system", content: RULES },
  { role: "user", content: "Prépare une semaine fictive de deux séances avec ces trois exercices. Le champ notebook reste vide." },
];
const r3 = await send(OPUS, emitMessages, { responseFormat: small, maxTokens: 8192 });
let parses = false;
try { JSON.parse(text(r3.body)); parses = true; } catch { /* reported below */ }
const iterations = events(r3.body).some((e) => e.usage?.iterations || e.message?.usage?.iterations);
log("3 emit small schema", r3, `parses=${parses} iterations=${iterations}`);
if (r3.status === 200 && !parses) unexpected.push("3 emit small schema: payload does not parse");
if (r3.status === 200) save(EMIT_FIXTURE, r3.body);

// 4. Emit with the REAL schema from the live catalog: status only.
const { getDb } = await import("../netlify/functions/lib/db.js");
const { loadCatalog } = await import("../netlify/functions/lib/catalogDb.js");
const { buildCatalogViews } = await import("../src/lib/catalog.js");
const { buildPromptInputs } = await import("../netlify/functions/lib/coachPromptInputs.js");
const { offeredExerciseNames } = await import("../netlify/functions/lib/coachPrompt.js");
const views = buildCatalogViews((await loadCatalog(getDb())).doc);
const { structure } = buildPromptInputs(views);
const names = offeredExerciseNames(structure.exerciseAvailability, views.blacklist);
const real = jsonSchemaResponseFormat(PLAN_SCHEMA_NAME, buildPlanJsonSchema(names));
const r4 = await send(OPUS, emitMessages, { responseFormat: real, maxTokens: 8192 });
log("4 emit real schema", r4, `enum=${names.length}`);

// 5. A list opening on an assistant turn, sent RAW (bypassing the guard).
const raw5 = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: buildAnthropicRequest(OPUS, chat).headers,
  body: JSON.stringify({ model: OPUS.model, max_tokens: 256, messages: [
    { role: "assistant", content: "Bonjour." }, { role: "user", content: "Salut" },
  ] }),
});
log("5 leading assistant (raw)", { status: raw5.status, body: await raw5.text() });

// 6. An empty user turn, sent RAW.
const raw6 = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: buildAnthropicRequest(OPUS, chat).headers,
  body: JSON.stringify({ model: OPUS.model, max_tokens: 256, messages: [
    { role: "user", content: "" }, { role: "assistant", content: "Oui ?" }, { role: "user", content: "Salut" },
  ] }),
});
log("6 empty turn (raw)", { status: raw6.status, body: await raw6.text() }, "", 400);

// 7. Sonnet.
const r7 = await send(SONNET, chat);
log("7 chat sonnet", r7, `text=${JSON.stringify(text(r7.body).slice(0, 80))}`);

if (authFailed) {
  console.error("anthropic-probe: could not run — the key was refused (401/403); fixtures NOT re-recorded");
  process.exit(2);
}
if (unexpected.length) {
  console.error(`anthropic-probe: ${unexpected.length} probe(s) answered otherwise:\n  ${unexpected.join("\n  ")}`);
  process.exit(1);
}
