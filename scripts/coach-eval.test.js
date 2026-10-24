import { describe, it, expect } from "vitest";
import { STATIC_CASES, buildCases, evalEntries, callOnce } from "./coach-eval.mjs";
import { MODEL_LADDER, PLAN_EMIT_LADDER, ladderFor } from "../netlify/functions/lib/providers.js";
import { parseArgs, median, splitReply, deriveRowingCase, lastLoggedRowingWeight, mapRows, evalExitCode, evalExitReason } from "./coach-eval-lib.mjs";

const byId = (id) => STATIC_CASES.find((c) => c.id === id);

describe("coach-eval harness", () => {
  it("the closed-question check rejects a three-sentence answer", () => {
    expect(byId("closed").check("Oui. Pas de souci. Tu peux même monter à deux minutes.")).toBe(false);
    expect(byId("closed").check("Oui, 90 secondes suffisent.")).toBe(true);
  });

  it("the next-week check wants the Plan button, brevity and no prose programme", () => {
    const c = byId("next-week").check;
    expect(c("Appuie sur « Plan » et je te prépare ça.")).toBe(true);
    expect(c("Voilà.\nLundi : squats\nMardi : tractions\nPlan")).toBe(false);
    expect(c("Dis-moi où tu en es de ton cycle.")).toBe(false);
  });

  it("the shrugs check fails a reply that offers to delete", () => {
    expect(byId("shrugs").check("Honnêtement, on peut les supprimer.")).toBe(false);
    expect(byId("shrugs").check("Utiles pour les trapèzes, surtout en fin de séance.")).toBe(true);
  });

  // Typed-block replies are read by the production parser now (sse.test.js
  // covers contentText); what is left here is the flag parsing.
  it("parses its flags and refuses an effort the API would 400 on", () => {
    expect(parseArgs([])).toEqual({ planEmit: false, claudeEffort: null });
    expect(parseArgs(["--claude-effort=medium", "--plan-emit"])).toEqual({ planEmit: true, claudeEffort: "medium" });
    // Regression: c5d24a2 then 5a01fa9 — `--large` added the floor while Large 3
    // was the floor; once Large 4 took rung 1 and Medium the floor it added Medium
    // while reading as "add Large" (so it became `--floor`), and under --plan-emit
    // skipping the floor skipped GLM, the model --glm-effort exists to measure.
    // Every rung is evaluated now; neither flag exists.
    expect(() => parseArgs(["--large"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--floor"])).toThrow(/unknown argument/);
    // GLM left the ladder on 2026-10-12, and --glm-effort with it.
    expect(() => parseArgs(["--glm-effort=low"])).toThrow(/unknown argument/);
    // Opus/Sonnet 5.5 cannot turn thinking off: "none" would be a 400.
    expect(() => parseArgs(["--claude-effort=none"])).toThrow(/low, medium, high, xhigh or max/);
  });

  // Regression: 962f56b — the harness hardcoded its model list and sent
  // no reasoning_effort unless --glm-effort was given, so a plain run scored
  // GLM at its DEFAULT effort while production runs it at "low", and a ladder
  // change would have gone on being evaluated against the old ladder.
  describe("evalEntries follows the production ladder", () => {
    it("evaluates every rung, the floor included, with the ladder's own effort", () => {
      expect(evalEntries()).toEqual(MODEL_LADDER);
      expect(evalEntries().map((e) => e.reasoningEffort)).toEqual(MODEL_LADDER.map((e) => e.reasoningEffort));
    });

    it("walks the plan-emit ladder under --plan-emit, the one production walks for that request", () => {
      // The same order as chat since 2026-10-12, but read from PLAN_EMIT_LADDER,
      // so an emit-only reorder is evaluated the day it lands.
      expect(evalEntries({ mode: "plan-emit" })).toEqual(PLAN_EMIT_LADDER);
      expect(ladderFor("plan-emit")).toBe(PLAN_EMIT_LADDER);
    });

    it("lets --claude-effort override the Claude rungs only, without touching the ladder", () => {
      const before = JSON.stringify(MODEL_LADDER);
      const entries = evalEntries({ claudeEffort: "medium" });
      for (const e of entries) {
        if (e.provider === "anthropic") expect(e.reasoningEffort).toBe("medium");
        else expect(e.reasoningEffort).toBe(MODEL_LADDER.find((l) => l.model === e.model).reasoningEffort);
      }
      expect(JSON.stringify(MODEL_LADDER)).toBe(before);
    });
  });

  // Regression: 029636c — a 401 on every request exited 1, which reads as
  // "the models failed the cases" when nothing was measured at all.
  it("exits 2 when every request errored or none ran, 1 on a finding, 0 when clean", () => {
    expect(evalExitCode([])).toBe(2);
    expect(evalExitCode([{ errored: true, failed: true }, { errored: true, failed: true }])).toBe(2);
    expect(evalExitCode([{ errored: true, failed: true }, { errored: false, failed: true }])).toBe(1);
    expect(evalExitCode([{ errored: false, failed: false }])).toBe(0);
  });

  // Regression: bfa9ef0 — an errored request carries failed: true, and it
  // was counted as a failed case: one 503 among passing cases exited 1, a
  // finding about the models, when that request measured nothing. Failures
  // count only on measured outcomes; an error with no measured failure is 2.
  it("never counts an errored request as a failed case", () => {
    expect(evalExitCode([{ errored: false, failed: false }, { errored: true, failed: true }])).toBe(2);
    expect(evalExitCode([{ errored: false, failed: true }, { errored: true, failed: true }])).toBe(1);
    expect(evalExitCode([{ errored: false, failed: false }, { errored: false, failed: false }])).toBe(0);
  });

  // Regression: a693b82 — exit 2 printed "a request errored" even when
  // nothing ran at all, sending the reader to look for a key or quota error.
  it("says which of the two causes made a run exit 2", () => {
    expect(evalExitReason([])).toMatch(/^no request was sent/);
    expect(evalExitReason([{ errored: false, failed: false }, { errored: true, failed: true }])).toMatch(/^1 of 2 requests errored/);
    expect(evalExitReason([{ errored: false, failed: true }])).toBeNull();
    expect(evalExitReason([{ errored: false, failed: false }])).toBeNull();
  });

  it("median is null on nothing, never 0", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 10])).toBe(3);
  });

  it("strips the notebook trailer from the visible reply and keeps it apart", () => {
    const r = splitReply("Oui, 90 secondes.\n<<<NOTEBOOK>>>\n- le 01/10 : repos 90s\n<<<END>>>");
    expect(r.visible).toBe("Oui, 90 secondes.");
    expect(r.trailer).toBe("- le 01/10 : repos 90s");
    expect(splitReply("Juste ça.")).toEqual({ visible: "Juste ça.", trailer: "" });
  });

  it("a reply that is closed-question-short only counts once the trailer is gone", () => {
    const raw = "Oui, 90 secondes suffisent.\n<<<NOTEBOOK>>>\n- une. Deux. Trois. Quatre.\n<<<END>>>";
    expect(byId("closed").check(raw)).toBe(false);
    expect(byId("closed").check(splitReply(raw).visible)).toBe(true);
  });

  describe("rowing case derivation", () => {
    const plan = { sessions: [{ exercises: [{ name: "Squat", weight: 20 }, { name: "Rowing haltères", weight: 12 }] }] };
    const sessions = [
      { date: "2026-09-01", exercises: [{ name: "Rowing haltères", sets: [{ weight: 10 }] }] },
      { date: "2026-09-20", exercises: [{ name: "Rowing haltères", sets: [{ weight: 14 }, { weight: 12 }] }] },
    ];

    it("takes the planned weight and her last logged weight when they differ", () => {
      const c = deriveRowingCase(plan, sessions);
      expect([c.planned, c.other]).toEqual([12, 14]);
      expect(c.message).toBe("Le rowing c'est 12 ou 14 ?");
      expect(c.check("Le plan dit 12 aujourd'hui.")).toBe(true);
      expect(c.check("Aujourd'hui tu fais 14.")).toBe(false);
      expect(c.check("Le plan prévoit 112.")).toBe(false);
      expect(c.check("12 kg.")).toBe(false); // no plan mention
    });

    it("uses planned+1 when nothing differs was logged", () => {
      expect(deriveRowingCase(plan, []).other).toBe(13);
      const same = [{ date: "2026-09-20", exercises: [{ name: "Rowing", sets: [{ weight: 12 }] }] }];
      expect(deriveRowingCase(plan, same).other).toBe(13);
      expect(lastLoggedRowingWeight(same)).toBe(12);
    });

    it("is SKIPPED, never invented, when the plan has no rowing line", () => {
      const c = deriveRowingCase({ sessions: [{ exercises: [{ name: "Squat", weight: 20 }] }] }, sessions);
      expect(c.skip).toBe(true);
      expect(c.message).toBeUndefined();
      expect(deriveRowingCase(null, []).skip).toBe(true);
    });

    it("buildCases keeps five slots, the rowing one third", () => {
      expect(buildCases(plan, sessions).map((c) => c.id)).toEqual([
        "closed", "monday", "rowing-planned-vs-other", "shrugs", "next-week",
      ]);
    });
  });

  it("mapRows mirrors the client pull: flat session, date-only, plan merged with its data", () => {
    const { sessions, plan, profile } = mapRows({
      sessionRows: [{ id: "a", date: "2026-09-01T00:00:00.000Z", name: "Haut", data: { exercises: [] } }],
      planRow: { week_start: "2026-09-28", week_end: "2026-09-04", data: { sessions: [] }, raw: "r" },
      profileRow: { data: { name: "L" } },
    }, null);
    expect(sessions[0]).toMatchObject({ id: "a", date: "2026-09-01", name: "Haut", exercises: [] });
    expect(plan).toMatchObject({ weekStart: "2026-09-28", weekEnd: "2026-09-04", raw: "r", sessions: [] });
    expect(profile).toEqual({ name: "L" });
  });

  // Regression: 821e2f6 — first_text_ms was stamped on the first non-empty
  // delta, so a rung opening on whitespace read as fast.
  // Regression: f0bb0ae — it was then stamped on a raw-text predicate
  // while production commits on what the notebook splitter forwards, so a
  // rung opening on a notebook block read as fast here and as silent there.
  const slowBody = (deltas) => {
    const enc = new TextEncoder();
    const chunk = (content) => enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    return new ReadableStream({
      async pull(c) {
        if (!deltas.length) return void c.close();
        await new Promise((r) => setTimeout(r, 30));
        c.enqueue(chunk(deltas.shift()));
      },
    });
  };
  // Mistral wire bytes, so a Mistral rung (the Claude rungs read another dialect).
  const MISTRAL_RUNG = MODEL_LADDER.find((e) => e.provider === "mistral");

  it("reads a Claude rung with the Anthropic parser, as production does", async () => {
    const { readFileSync } = await import("node:fs");
    const wire = readFileSync(new URL("../netlify/__tests__/fixtures/anthropic-chat.sse", import.meta.url), "utf8");
    const text = wire.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)))
      .filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text).join("");
    const r = await callOnce(MODEL_LADDER[0], [{ role: "user", content: "x" }], {}, async (url) => {
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      return new Response(wire, { status: 200 });
    });
    expect(r.reply).toBe(text);
    expect(r.finish).toBe("stop");
    expect(r.firstTextMs).not.toBeNull();
  });

  it("stamps first_text_ms where production commits: after the splitter, not on raw text", async () => {
    const deltas = [" ", "<<<NOTEBOOK>>>\n+ note\n<<<END>>>", "Oui, douze kilos."];
    const r = await callOnce(MISTRAL_RUNG, [{ role: "user", content: "x" }], {}, async () => new Response(slowBody(deltas), { status: 200 }));
    expect(r.reply).toBe(" <<<NOTEBOOK>>>\n+ note\n<<<END>>>Oui, douze kilos.");
    // Three 30 ms pauses before "Oui" arrives; the notebook lands after two.
    expect(r.firstTextMs).toBeGreaterThanOrEqual(85);
  });

  it("stamps a short reply when the splitter releases it at the end", async () => {
    const r = await callOnce(MISTRAL_RUNG, [{ role: "user", content: "x" }], {}, async () => new Response(slowBody(["Oui."]), { status: 200 }));
    expect(r.firstTextMs).not.toBeNull();
  });

  it("stamps the first payload character on plan-emit, where there is no splitter", async () => {
    const r = await callOnce(MISTRAL_RUNG, [{ role: "user", content: "x" }], { responseFormat: { type: "json_schema" } },
      async () => new Response(slowBody(["\n", "{\"a\":", "1}"]), { status: 200 }));
    expect(r.reply).toBe('\n{"a":1}');
    expect(r.firstTextMs).toBeGreaterThanOrEqual(55);
    expect(r.firstTextMs).toBeLessThan(r.ms);
  });

  // Regression (the fix(eval) flush commit, which cannot cite its own hash) — the eval broke on done without flushing the
  // parser, so a final SSE line with no trailing newline (where Mistral puts
  // finish_reason and usage) was dropped, as production once did.
  it("flushes the last SSE line when the stream ends without a newline", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Oui." } }] })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: " Dix." }, finish_reason: "stop" }], usage: { completion_tokens: 7 } })}`));
        c.close();
      },
    });
    const r = await callOnce(MISTRAL_RUNG, [{ role: "user", content: "x" }], {}, async () => new Response(body, { status: 200 }));
    expect(r.reply).toBe("Oui. Dix.");
    expect(r.finish).toBe("stop");
    expect(r.tokens).toBe(7);
  });
});
