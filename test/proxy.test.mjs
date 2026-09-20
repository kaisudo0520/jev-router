import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeSchema,
  newTurnPrompt,
  applyTier,
  claudeModels,
  conversationKey,
  sessionOf,
  startProxy,
  tokenEstimate,
} from "../src/proxy.mjs";
import { setEnv, captureUpstream } from "./helpers.mjs";

test("only the sentinel model is routed", () => {
  assert.equal(isAuto("jev-router"), true);
  assert.equal(isAuto("claude-opus-4-6"), false, "a model the user picked is theirs");
  assert.equal(isAuto("claude-haiku-4-5-20251001"), false, "internal Haiku calls pass through");
  assert.equal(isAuto(undefined), false);
});

test("the sentinel is not mistaken for a real tier", () => {
  assert.equal(tierOf("jev-router"), null);
});
import { tierOf, isAuto } from "../src/config.mjs";
import { writeDecision, writeStatus, readStatus, pruneStale, STATUS_DIR } from "../src/status.mjs";
import { mkdirSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

test("reads the session id out of Claude Code's metadata", () => {
  const sid = "11111111-2222-4333-8444-555555555555";
  assert.equal(sessionOf({ metadata: { user_id: JSON.stringify({ session_id: sid }) } }), sid);
  assert.equal(sessionOf({ metadata: { user_id: "not-json" } }), "");
  assert.equal(sessionOf({}), "");
});

test("status round-trips per session and misses cleanly", () => {
  const sid = `test-${process.pid}`;
  writeStatus(sid, { tier: "opus", confidence: 0.87, reason: "jev" });
  assert.deepEqual(readStatus(sid), { tier: "opus", confidence: 0.87, reason: "jev" });
  assert.equal(readStatus("no-such-session"), null);
  assert.doesNotThrow(() => writeStatus("", { tier: "opus" }));
});

test("status files are private to their owner", { skip: process.platform === "win32" }, () => {
  const sid = `perm-${process.pid}`;
  writeStatus(sid, { tier: "opus" });
  assert.equal(statSync(STATUS_DIR).mode & 0o777, 0o700);
  assert.equal(statSync(join(STATUS_DIR, `${sid}.json`)).mode & 0o777, 0o600);
});

test("stale status files are pruned and fresh ones kept", () => {
  mkdirSync(STATUS_DIR, { recursive: true });
  const stale = join(STATUS_DIR, `stale-${process.pid}.json`);
  const fresh = join(STATUS_DIR, `fresh-${process.pid}.json`);
  writeFileSync(stale, "{}");
  writeFileSync(fresh, "{}");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  assert.ok(pruneStale() >= 1);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
});

test("routing status retains the exact recent Jev exchanges", () => {
  const sid = `history-${process.pid}`;
  writeDecision(sid, { prompt: "first", jev: { request: { id: 1 }, response: { confidence: 0.6 } } });
  writeDecision(sid, { prompt: "second", jev: { request: { id: 2 }, response: { confidence: 0.8 } } });
  const status = readStatus(sid);
  assert.equal(status.prompt, "second");
  assert.deepEqual(status.history.map(({ prompt }) => prompt), ["first", "second"]);
  assert.equal(status.history[0].jev.response.confidence, 0.6);
});

test("recognises older model versions within a tier", () => {
  assert.equal(tierOf("claude-sonnet-4-6"), "sonnet");
  assert.equal(tierOf("claude-sonnet-5"), "sonnet");
  assert.equal(tierOf("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(tierOf("claude-opus-4-1"), "opus");
  assert.equal(tierOf("claude-fable-5-1[1m]"), "fable");
  assert.equal(tierOf("gpt-9"), null);
  assert.equal(tierOf(undefined), null);
});

test("keeps available Claude model versions as separate Jev choices", () => {
  assert.deepEqual(
    claudeModels([
      { id: "claude-opus-5", display_name: "Claude Opus 5" },
      { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
    ]).map(({ id, tier }) => ({ id, tier })),
    [
      { id: "claude-opus-5", tier: "opus" },
      { id: "claude-opus-4-8", tier: "opus" },
    ],
  );
});

test("Claude proxy sends exact account models to Jev and routes the chosen version", async (t) => {
  const { seen, url } = await captureUpstream(t, {
    catalog: [
      { id: "claude-opus-5", display_name: "Claude Opus 5" },
      { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
      { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
    ],
  });

  const { port, close } = await startProxy({
    upstreamURL: url,
    route: async ({ models }) => {
      assert.deepEqual(models.map((model) => model.id), [
        "claude-opus-5",
        "claude-opus-4-8",
        "claude-sonnet-5",
      ]);
      return { choice: "claude-opus-4-8", confidence: 0.91, ms: 1 };
    },
  });
  t.after(close);

  await fetch(`http://127.0.0.1:${port}/v1/models`).then((response) => response.json());
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      tools: [{ name: "Bash" }],
      messages: [{ role: "user", content: "debug this race" }],
    }),
  });

  assert.equal(seen[0].model, "claude-opus-4-8");
});

test("a routed request without metadata is recorded under the conversation key", async (t) => {
  const { url } = await captureUpstream(t);

  const { port, close } = await startProxy({
    upstreamURL: url,
    route: async () => ({ choice: "claude-sonnet-5", confidence: 0.77, ms: 1 }),
  });
  t.after(close);

  // Exactly what `claude -p` sends first: no metadata, so no session id.
  const body = {
    model: "jev-router",
    tools: [{ name: "Bash" }],
    messages: [{ role: "user", content: `rename this variable ${process.pid}` }],
  };
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal(sessionOf(body), "", "the request carries no session id");
  const status = readStatus(conversationKey(body));
  assert.ok(status, "the decision is filed under the conversation key instead of being dropped");
  assert.equal(status.tier, "sonnet");
  assert.equal(status.confidence, 0.77);
});

const withTools = (messages) => ({ tools: [{ name: "Bash" }], messages });

test("converts a draft-04 boolean exclusiveMinimum into a draft 2020-12 number", () => {
  const schema = { type: "object", properties: { topN: { minimum: 0, exclusiveMinimum: true } } };
  sanitizeSchema(schema);
  assert.deepEqual(schema.properties.topN, { exclusiveMinimum: 0 });
});

test("drops a false exclusiveMaximum and keeps the bound", () => {
  const schema = { properties: { n: { maximum: 10, exclusiveMaximum: false } } };
  sanitizeSchema(schema);
  assert.deepEqual(schema.properties.n, { maximum: 10 });
});

test("leaves an already-valid numeric bound alone", () => {
  const schema = { properties: { n: { exclusiveMinimum: 5 } } };
  sanitizeSchema(schema);
  assert.equal(schema.properties.n.exclusiveMinimum, 5);
});

test("reaches schemas nested in arrays and sub-objects", () => {
  const schema = { anyOf: [{ items: { minimum: 1, exclusiveMinimum: true } }] };
  sanitizeSchema(schema);
  assert.deepEqual(schema.anyOf[0].items, { exclusiveMinimum: 1 });
});

test("survives null and primitive nodes", () => {
  assert.doesNotThrow(() => sanitizeSchema(null));
  assert.doesNotThrow(() => sanitizeSchema({ a: null, b: 3, c: "x" }));
});

test("reads a plain string prompt as a new turn", () => {
  assert.equal(newTurnPrompt(withTools([{ role: "user", content: "fix the bug" }])), "fix the bug");
});

test("reads a text block prompt as a new turn", () => {
  const body = withTools([{ role: "user", content: [{ type: "text", text: "fix the bug" }] }]);
  assert.equal(newTurnPrompt(body), "fix the bug");
});

test("ignores a tool_result continuation mid-turn", () => {
  const body = withTools([
    { role: "user", content: "fix the bug" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
  ]);
  assert.equal(newTurnPrompt(body), null);
});

test("ignores auxiliary calls that carry no tools", () => {
  const body = { messages: [{ role: "user", content: "summarise this" }] };
  assert.equal(newTurnPrompt(body), null);
});

test("ignores a request whose last message is from the assistant", () => {
  const body = withTools([{ role: "assistant", content: "thinking" }]);
  assert.equal(newTurnPrompt(body), null);
});

test("ignores an empty prompt", () => {
  assert.equal(newTurnPrompt(withTools([{ role: "user", content: "   " }])), null);
});

test("survives a malformed body", () => {
  assert.equal(newTurnPrompt(undefined), null);
  assert.equal(newTurnPrompt({}), null);
  assert.equal(newTurnPrompt({ tools: [], messages: [] }), null);
});

test("strips system reminders Claude Code injects into the prompt", () => {
  const body = withTools([
    {
      role: "user",
      content: "fix the bug\n<system-reminder>be careful\nabout things</system-reminder>",
    },
  ]);
  assert.equal(newTurnPrompt(body), "fix the bug");
});

test("a prompt that is only a system reminder is not a turn", () => {
  const body = withTools([{ role: "user", content: "<system-reminder>noise</system-reminder>" }]);
  assert.equal(newTurnPrompt(body), null);
});

test("routing to haiku strips fields haiku cannot accept", () => {
  const body = {
    model: "claude-sonnet-4-6",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
  };
  applyTier(body, "haiku");
  assert.equal(body.model, "claude-haiku-4-5-20251001");
  assert.equal(body.thinking, undefined);
  assert.equal(body.output_config, undefined);
  assert.equal(body.context_management, undefined);
});

test("routing to haiku keeps context-management strategies unrelated to thinking", () => {
  const body = {
    model: "claude-sonnet-4-6",
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }, { type: "clear_thinking_20251015" }] },
  };
  applyTier(body, "haiku");
  assert.deepEqual(body.context_management, { edits: [{ type: "clear_tool_uses_20250919" }] });
});

test("routing to opus leaves thinking and effort intact", () => {
  const body = {
    model: "claude-sonnet-4-6",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
  };
  applyTier(body, "opus");
  assert.equal(body.model, "claude-opus-5");
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.deepEqual(body.output_config, { effort: "medium" });
});

test("an unknown tier leaves the request untouched", () => {
  const body = { model: "claude-sonnet-4-6", thinking: { type: "adaptive" } };
  applyTier(body, "nonsense");
  assert.equal(body.model, "claude-sonnet-4-6");
});

test("a conversation keeps one key as it grows, and differs from a sub-agent", () => {
  const main = { messages: [{ role: "user", content: "main task" }] };
  const grown = {
    messages: [{ role: "user", content: "main task" }, { role: "assistant", content: "ok" }],
  };
  const sub = { messages: [{ role: "user", content: "sub-agent task" }] };
  assert.equal(conversationKey(main), conversationKey(grown));
  assert.notEqual(conversationKey(main), conversationKey(sub));
});

test("the key ignores the cache_control breakpoint Claude Code moves between requests", () => {
  const first = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>x</system-reminder>" },
          { type: "text", text: "do the thing", cache_control: { type: "ephemeral", ttl: "1h" } },
        ],
      },
    ],
  };
  const later = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>x</system-reminder>" },
          { type: "text", text: "do the thing" },
        ],
      },
      { role: "assistant", content: "working" },
    ],
  };
  assert.equal(conversationKey(first), conversationKey(later));
});

test("the same opening text in two sessions gets two keys", () => {
  const mk = (id) => ({
    metadata: { user_id: JSON.stringify({ session_id: id }) },
    messages: [{ role: "user", content: "same opening" }],
  });
  assert.notEqual(conversationKey(mk("a")), conversationKey(mk("b")));
});

test("the key survives metadata that is not JSON", () => {
  const body = { metadata: { user_id: "not-json" }, messages: [{ role: "user", content: "hi" }] };
  assert.doesNotThrow(() => conversationKey(body));
});

/** Every routing knob unset, so a developer's own environment cannot steer these tests. */
const KNOBS_UNSET = {
  JEV_STRONG_TIER: undefined,
  JEV_MIN_AUTO_TIER: undefined,
  JEV_DOWNGRADE_CUTOFF_TOKENS: undefined,
  JEV_TIER_SHIFT: undefined,
};

const post = (port, messages) =>
  fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "jev-router", tools: [{ name: "Bash" }], messages }),
  });

const imageBlock = (bytes) => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "A".repeat(bytes) },
});

test("a first turn Jev cannot judge lands on the shipped baseline, not the configured tier", async (t) => {
  const { seen, url } = await captureUpstream(t);
  setEnv(t, { ...KNOBS_UNSET, JEV_STRONG_TIER: "fable", JEV_ALLOW_FABLE: "1" });

  const { port, close } = await startProxy({
    upstreamURL: url,
    // Jev unreachable, so the decision falls back to whatever the session's baseline is.
    route: async () => null,
  });
  t.after(close);

  await post(port, [{ role: "user", content: `unjudged first turn ${process.pid}` }]);

  // Fable bills extra: with no signal from Jev there is no reason to start a session there.
  assert.equal(seen[0].model, "claude-opus-5");
});

test("the guards never hold a first turn on a configured tier nothing is cached on", async (t) => {
  const { seen, url } = await captureUpstream(t);
  setEnv(t, { ...KNOBS_UNSET, JEV_STRONG_TIER: "fable", JEV_ALLOW_FABLE: "1" });

  const { port, close } = await startProxy({
    upstreamURL: url,
    route: async () => ({ choice: "claude-sonnet-5", confidence: 0.9, ms: 1 }),
  });
  t.after(close);

  // A large first paste, past the downgrade cutoff, so the cache-rebuild guard holds the
  // baseline. Measured against the configured tier that would pin the session to Fable
  // although nothing has been cached there yet.
  await post(port, [{ role: "user", content: `${"x".repeat(200000)} ${process.pid}` }]);

  assert.equal(seen[0].model, "claude-opus-5");
});

test("a downgrade is sized against the whole request, not the messages alone", async (t) => {
  const { seen, url } = await captureUpstream(t);
  setEnv(t, { ...KNOBS_UNSET, JEV_DOWNGRADE_CUTOFF_TOKENS: "1000000" });

  const { port, close } = await startProxy({
    upstreamURL: url,
    route: async () => ({ choice: "claude-haiku-4-5-20251001", confidence: 0.9, ms: 1 }),
  });
  t.after(close);

  // The messages alone fit Haiku's 200K window; with the tool schemas Claude Code sends
  // alongside them the request does not, and the API would reject it outright.
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      tools: [{ name: "Bash", description: "y".repeat(700000) }],
      messages: [{ role: "user", content: `${"x".repeat(160000)} ${process.pid}` }],
    }),
  });

  assert.equal(seen[0].model, "claude-opus-5", "held rather than sent where it cannot fit");
});

test("a downgrade is sized against the window of the exact model Jev chose", async (t) => {
  const { seen, url } = await captureUpstream(t, {
    catalog: [
      { id: "claude-opus-5", display_name: "Claude Opus 5", max_input_tokens: 1000000 },
      { id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5", max_input_tokens: 200000 },
    ],
  });
  setEnv(t, { ...KNOBS_UNSET, JEV_DOWNGRADE_CUTOFF_TOKENS: "1000000" });

  const { port, close } = await startProxy({
    upstreamURL: url,
    route: async () => ({ choice: "claude-sonnet-4-5", confidence: 0.9, ms: 1 }),
  });
  t.after(close);

  await fetch(`http://127.0.0.1:${port}/v1/models`).then((response) => response.json());
  // Every current Sonnet takes 1M tokens; the version Jev picked from the catalog takes 200K.
  await post(port, [{ role: "user", content: `${"x".repeat(900000)} ${process.pid}` }]);

  assert.equal(seen[0].model, "claude-opus-5");
});

test("Jev picking the model already running is not reported as a refused switch", async (t) => {
  const { seen, url } = await captureUpstream(t, {
    catalog: [
      { id: "claude-opus-4-8", display_name: "Claude Opus 4.8", max_input_tokens: 200000 },
      { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", max_input_tokens: 1000000 },
    ],
  });
  setEnv(t, KNOBS_UNSET);

  const { port, close } = await startProxy({
    upstreamURL: url,
    route: async () => ({ choice: "claude-opus-4-8", confidence: 0.9, ms: 1 }),
  });
  t.after(close);

  await fetch(`http://127.0.0.1:${port}/v1/models`).then((response) => response.json());
  // The session's opus model is the 200K entry; Jev picks it again for a request it cannot
  // hold. Nothing is switched, so nothing is reported as held: the API's refusal is the
  // same either way.
  const body = { model: "jev-router", tools: [{ name: "Bash" }], messages: [{ role: "user", content: `keep going ${"x".repeat(900000)} ${process.pid}` }] };
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal(seen[0].model, "claude-opus-4-8");
  assert.equal(readStatus(conversationKey(body)).reason, "jev/no-change");
});

test("a base64 image is budgeted at the API's ceiling, not at its byte length", () => {
  const tokens = tokenEstimate({ messages: [{ role: "user", content: [imageBlock(4000000)] }] });
  assert.ok(tokens > 1600 && tokens < 2000, `estimated ${tokens}`);
  // A "data" field that is not a base64 source is ordinary text and counts as such.
  const content = JSON.stringify({ data: "x".repeat(40000) });
  const result = { type: "tool_result", tool_use_id: "t1", content };
  assert.ok(tokenEstimate({ messages: [{ role: "user", content: [result] }] }) > 10000);
});

test("a base64 document is sized by its decoded bytes, not at the image ceiling", () => {
  // The API reads a document's pages, so unlike an image it is not capped at one block.
  // 400000 base64 characters decode to 300000 bytes: about 75000 tokens by the same
  // bytes-over-four rule that sizes text.
  const pdf = {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: "A".repeat(400000) },
  };
  const tokens = tokenEstimate({ messages: [{ role: "user", content: [pdf] }] });
  assert.ok(tokens > 74000 && tokens < 76000, `estimated ${tokens}`);
  // But not past what the API's page limit can cost: a scanned 5 MB PDF is a few dozen
  // pages, not the million-plus tokens its bytes would make of it.
  const scanned = { ...pdf, source: { ...pdf.source, data: "A".repeat(6700000) } };
  const capped = tokenEstimate({ messages: [{ role: "user", content: [scanned] }] });
  assert.ok(capped > 300000 && capped < 301000, `estimated ${capped}`);
});

test("the context Jev is told about budgets a pasted image the way the API does", async (t) => {
  const { url } = await captureUpstream(t);
  setEnv(t, KNOBS_UNSET);

  let told;
  const { port, close } = await startProxy({
    upstreamURL: url,
    route: async ({ contextTokens }) => {
      told = contextTokens;
      return { choice: "claude-sonnet-5", confidence: 0.9, ms: 1 };
    },
  });
  t.after(close);

  // By byte count this one screenshot is a million-token conversation, which would saturate
  // Jev's context metric and hold every later downgrade for the cache-rebuild guard.
  const text = { type: "text", text: `what is in this screenshot ${process.pid}` };
  await post(port, [{ role: "user", content: [imageBlock(4000000), text] }]);

  assert.ok(told > 1600 && told < 3000, `told ${told}`);
});

test("a tier reached by policy runs its newest entry, so that is the window checked", async (t) => {
  const { seen, url } = await captureUpstream(t, {
    catalog: [
      { id: "claude-opus-5", display_name: "Claude Opus 5", max_input_tokens: 1000000 },
      { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", max_input_tokens: 1000000 },
      { id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5", max_input_tokens: 200000 },
      { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", max_input_tokens: 200000 },
    ],
  });
  setEnv(t, { ...KNOBS_UNSET, JEV_TIER_SHIFT: "1", JEV_DOWNGRADE_CUTOFF_TOKENS: "1000000" });

  const { port, close } = await startProxy({
    upstreamURL: url,
    route: async () => ({ choice: "claude-haiku-4-5-20251001", confidence: 0.9, ms: 1 }),
  });
  t.after(close);

  await fetch(`http://127.0.0.1:${port}/v1/models`).then((response) => response.json());
  // Jev's 200K pick is shifted to sonnet, whose newest entry takes 1M: the request that
  // would not have fitted the pick fits what actually goes out.
  await post(port, [{ role: "user", content: `rename everything ${"x".repeat(900000)} ${process.pid}` }]);

  assert.equal(seen[0].model, "claude-sonnet-5");
});

test("pasted images do not freeze routing on the current tier", async (t) => {
  const { seen, url } = await captureUpstream(t);
  setEnv(t, { ...KNOBS_UNSET, JEV_ALLOW_FABLE: "1" });

  const { port, close } = await startProxy({
    upstreamURL: url,
    route: async () => ({ choice: "claude-fable-5-1", confidence: 0.9, ms: 1 }),
  });
  t.after(close);

  // Five megabytes of base64 is over a million "tokens" by byte count and a few thousand
  // real ones; sized by bytes, no tier would have room and the upgrade would be refused.
  const text = { type: "text", text: `plan the migration ${process.pid}` };
  await post(port, [{ role: "user", content: [imageBlock(5000000), text] }]);

  assert.equal(seen[0].model, "claude-fable-5-1");
});

test("a zero cutoff lets the first decision downgrade and holds every later one", async (t) => {
  const { seen, url } = await captureUpstream(t);
  setEnv(t, { ...KNOBS_UNSET, JEV_DOWNGRADE_CUTOFF_TOKENS: "0" });

  const answers = ["claude-sonnet-5", "claude-haiku-4-5-20251001"];
  const { port, close } = await startProxy({
    upstreamURL: url,
    route: async () => ({ choice: answers.shift(), confidence: 0.9, ms: 1 }),
  });
  t.after(close);

  const opening = { role: "user", content: `rename this variable ${process.pid}` };
  await post(port, [opening]);
  const reply = { role: "assistant", content: "done" };
  await post(port, [opening, reply, { role: "user", content: "and this one" }]);

  assert.equal(seen[0].model, "claude-sonnet-5", "no cache yet, so the baseline is not defended");
  assert.equal(seen[1].model, "claude-sonnet-5", "now there is one, and it is");
});

test("a configured tier the account cannot run never reaches a request", async (t) => {
  const { seen, url } = await captureUpstream(t);
  // The opt-in paid tier is explicitly NOT enabled.
  setEnv(t, { ...KNOBS_UNSET, JEV_STRONG_TIER: "fable", JEV_ALLOW_FABLE: undefined });

  const { port, close } = await startProxy({
    upstreamURL: url,
    route: async () => {
      throw new Error("a tool continuation carries no new prompt, so routing must not run");
    },
  });
  t.after(close);

  // A tool_result continuation: `newTurnPrompt` returns null, so `decide()` — and with it the
  // `available` clamp — never runs. The baseline is the only thing standing between the
  // configured tier and the wire.
  await post(port, [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  ]);

  assert.equal(seen[0].model, "claude-opus-5", "must fall back to the shipped strong tier, not Fable");
});
