// @vitest-environment node
import { describe, it, expect } from "vitest";
import { createDemoCoachClient, demoReply, DEMO_QUESTIONS, DEMO_FALLBACK, DEMO_OPENING, chunksOf } from "./coach.js";
import { buildDemoData, demoCatalogViews } from "./fixtures.js";
import { finalizeStream, STREAM_END_MARKER } from "../lib/coachStream.js";
import { evaluatePlanImport } from "../lib/planValidation.js";
import { isPlanPayload } from "../lib/planFromJson.js";

const NOW = new Date(2026, 9, 25, 12); // a Sunday: the whole week is done

function storeWith(data) {
  const map = new Map(Object.entries(data).map(([k, v]) => [k, JSON.stringify(v)]));
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), map };
}

async function readAll(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(dec.decode(value, { stream: true }));
  }
  return chunks;
}

describe("demo coach", () => {
  const data = buildDemoData(NOW);
  const ctx = { sessions: data.sessions, plan: data.currentPlan, profile: data.profile };

  it("answers each suggested question from the demo data, in the real coach's register", () => {
    for (const { question } of DEMO_QUESTIONS) {
      const reply = demoReply(question, "discussion", ctx, NOW);
      expect(reply).not.toBe(DEMO_FALLBACK);
      expect(reply.length).toBeGreaterThan(80);
      expect(reply.length).toBeLessThan(900);
      // No report layout: no heading, bold label, rule or table.
      expect(reply).not.toMatch(/(^|\n)#|\*\*|---|\|/);
      // Nutrition stays general: never a number of calories or grams.
      expect(reply).not.toMatch(/kcal|calorie|\d+\s?g\b/i);
    }
  });

  it("reads the squat progression off the history, not a fixed text", () => {
    const reply = demoReply("Comment progresse mon squat ?", "discussion", ctx, NOW);
    expect(reply).toContain("de 8 kg/main à 12 kg/main");
    expect(reply).toContain("12,5 kg/main"); // the next load her equipment allows
    const fewer = demoReply("Comment progresse mon squat ?", "discussion", { ...ctx, sessions: ctx.sessions.slice(0, 10) }, NOW);
    expect(fewer).not.toContain("12,5 kg/main");
  });

  it("names the next undone séance, or says the week is done", () => {
    expect(demoReply("Je fais quoi à ma prochaine séance ?", "discussion", ctx, NOW)).toContain("trois séances");
    const midweek = { ...ctx, sessions: ctx.sessions.filter((s) => s.date < "2026-10-21") };
    const reply = demoReply("Je fais quoi à ma prochaine séance ?", "discussion", midweek, NOW);
    expect(reply).toContain("« Bas du corps »");
    expect(reply).toContain("Squat 4×8 à 12 kg/main");
  });

  it("anything else gets the polite scripted refusal", () => {
    expect(demoReply("Et le cardio ?", "discussion", ctx, NOW)).toBe(DEMO_FALLBACK);
    expect(demoReply("Et le cardio ?", "plan", ctx, NOW)).toBe(DEMO_FALLBACK);
  });

  it("the Plan button gets next week's programme, importable, without the private notebook", () => {
    const payload = JSON.parse(demoReply("x", "plan-emit", ctx, NOW));
    expect(isPlanPayload(payload)).toBe(true);
    expect(payload).not.toHaveProperty("notebook");
    expect(payload.weekStart).toBe("2026-10-26");
    const verdict = evaluatePlanImport(payload, demoCatalogViews());
    expect(verdict.errors).toEqual([]);
    expect(verdict.shouldImport).toBe(true);
  });

  it("streams the reply in many chunks, ends on the end marker, and banks the exchange", async () => {
    const store = storeWith({ sessions: ctx.sessions, currentPlan: ctx.plan, profile: ctx.profile });
    const client = createDemoCoachClient({ store, now: () => NOW, delayMs: () => 0 });
    expect((await client.fetchCoachHistory()).messages).toEqual([{ role: "assistant", content: DEMO_OPENING }]);
    const question = DEMO_QUESTIONS[2].question;
    const chunks = await readAll(await client.sendCoachMessage({ message: question, mode: "discussion" }));
    expect(chunks.length).toBeGreaterThan(20);
    expect(chunks.at(-1)).toBe(STREAM_END_MARKER);
    const { text, interrupted, failed } = finalizeStream(chunks.join(""));
    expect(interrupted).toBe(false);
    expect(failed).toBeFalsy();
    expect(text).toBe(demoReply(question, "discussion", ctx, NOW));
    expect((await client.fetchCoachHistory()).messages).toEqual([
      { role: "user", content: question },
      { role: "assistant", content: text },
    ]);
  });

  it("paces the chunks: they arrive over time, not all at once", async () => {
    const store = storeWith({});
    const client = createDemoCoachClient({ store, now: () => NOW, delayMs: () => 25 });
    const res = await client.sendCoachMessage({ message: "bonjour", mode: "discussion" });
    const reader = res.body.getReader();
    const t0 = Date.now();
    await reader.read();
    await reader.read();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
    expect(chunksOf("un deux trois quatre cinq")).toEqual(["un deux ", "trois quatre ", "cinq"]);
  });
});
