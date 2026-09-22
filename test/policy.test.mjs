import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decide, detectOverride } from "../src/policy.mjs";
import { routedNormally } from "../src/reason.mjs";
import {
  QUESTIONS,
  TIERS,
  GUIDANCE_STRONG_TIER,
  contextWindowOf,
  shouldUseExactModel,
  policyFromEnv,
  DEFAULT_POLICY,
} from "../src/config.mjs";
import { withEnv } from "./helpers.mjs";

const ALL = ["haiku", "sonnet", "opus", "fable"];
const sure = (choice) => ({ choice, confidence: 0.95 });
const unsure = (choice) => ({ choice, confidence: 0.2 });
const base = { prompt: "refactor the parser", current: "sonnet", available: ALL, contextTokens: 0 };

test("score rubrics contain only API-valid descriptions", () => {
  for (const question of Object.values(QUESTIONS).filter((q) => q.type === "score")) {
    assert(question.criteria.every((description) => typeof description === "string"));
    assert(question.criteria.length <= 10);
  }
});

test("follows a confident Jev answer", () => {
  assert.deepEqual(decide({ ...base, jev: sure("opus") }), {
    tier: "opus",
    reason: "jev",
    changed: true,
  });
});

test("an explicit user override beats Jev", () => {
  const out = decide({ ...base, prompt: "use haiku to fix this typo", jev: sure("opus") });
  assert.equal(out.tier, "haiku");
  assert.equal(out.reason, "override");
});

test("detectOverride only fires on a real instruction", () => {
  assert.equal(detectOverride("switch to opus"), "opus");
  assert.equal(detectOverride("use luna"), "haiku");
  assert.equal(detectOverride("use strong"), "opus");
  assert.equal(detectOverride("the opus of his career"), null);
});

test("keeps the current model when Jev is unreachable", () => {
  const out = decide({ ...base, jev: null });
  assert.equal(out.tier, "sonnet");
  assert.equal(out.changed, false);
  assert.match(out.reason, /jev-unavailable/);
});

test("ignores a tier name Jev invented", () => {
  assert.equal(decide({ ...base, jev: sure("gpt-9") }).tier, "sonnet");
});

test("never downgrades on a low-confidence answer", () => {
  const out = decide({ ...base, jev: unsure("haiku") });
  assert.equal(out.tier, "sonnet");
  assert.match(out.reason, /low-confidence-no-downgrade/);
});

test("caps a low-confidence upgrade at the safe ceiling", () => {
  const out = decide({ ...base, current: "haiku", jev: unsure("fable") });
  assert.equal(out.tier, "sonnet");
  assert.equal(out.reason, "low-confidence-capped");
});

test("still allows a confident upgrade to fable", () => {
  assert.equal(decide({ ...base, jev: sure("fable") }).tier, "fable");
});

test("refuses a downgrade once the cache rebuild costs more than it saves", () => {
  const out = decide({ ...base, current: "opus", jev: sure("haiku"), contextTokens: 80000 });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /cache-rebuild/);
});

test("allows the same downgrade early in a conversation", () => {
  assert.equal(decide({ ...base, current: "opus", jev: sure("haiku") }).tier, "haiku");
});

test("substitutes upward when the chosen tier is unavailable", () => {
  const out = decide({ ...base, current: "haiku", available: ["haiku", "opus"], jev: sure("sonnet") });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /unavailable/);
});

test("never substitutes upward into paid fable", () => {
  const out = decide({ ...base, current: "haiku", available: ["haiku", "fable"], jev: sure("opus") });
  assert.equal(out.tier, "haiku");
});

test("accepts exact model changes within the same tier", () => {
  assert.equal(shouldUseExactModel("jev/no-change", "opus", "opus"), true);
  assert.equal(shouldUseExactModel("low-confidence-no-downgrade/no-change", "opus", "opus"), false);
});

test("no policy argument is exactly the shipped behaviour", () => {
  assert.deepEqual(DEFAULT_POLICY, {
    strongTier: "opus",
    minAutoTier: null,
    downgradeCutoffTokens: 20000,
    tierShift: 0,
  });
  const out = decide({ ...base, current: "opus", jev: sure("haiku"), contextTokens: 80000 });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /cache-rebuild/);
});

test("a raised downgrade cutoff allows a downgrade in a longer conversation", () => {
  const out = decide({
    ...base,
    current: "opus",
    jev: sure("haiku"),
    contextTokens: 80000,
    policy: { downgradeCutoffTokens: 200000 },
  });
  assert.equal(out.tier, "haiku");
  assert.equal(out.reason, "jev");
});

test("a lowered downgrade cutoff blocks a downgrade the default would allow", () => {
  const out = decide({
    ...base,
    current: "opus",
    jev: sure("haiku"),
    contextTokens: 5000,
    policy: { downgradeCutoffTokens: 1000 },
  });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /cache-rebuild/);
});

test("a zero downgrade cutoff turns automatic downgrades off at every context size", () => {
  for (const contextTokens of [0, 1, 80000]) {
    const out = decide({
      ...base,
      current: "opus",
      jev: sure("haiku"),
      contextTokens,
      policy: { downgradeCutoffTokens: 0 },
    });
    assert.equal(out.tier, "opus", `contextTokens ${contextTokens} should not downgrade`);
    assert.match(out.reason, /cache-rebuild/);
  }
});

test("a floor keeps automatic routing off the tiers below it", () => {
  const out = decide({ ...base, current: "opus", jev: sure("haiku"), policy: { minAutoTier: "sonnet" } });
  assert.equal(out.tier, "sonnet");
  assert.match(out.reason, /floor/);
});

test("the floor outranks the low-confidence ceiling", () => {
  const out = decide({ ...base, current: "haiku", jev: unsure("haiku"), policy: { minAutoTier: "opus" } });
  assert.equal(out.tier, "opus", "the ceiling must not pull the tier back under the floor");
  assert.equal(out.reason, "jev+floor", "nothing was capped, so the turn is not reported as held");
});

test("a weak signal is reported as capped only when the cap moved the tier", () => {
  const policy = { minAutoTier: "sonnet" };
  const out = decide({ ...base, current: "haiku", jev: unsure("fable"), policy });
  assert.deepEqual(out, { tier: "sonnet", reason: "low-confidence-capped", changed: true });
  assert.equal(routedNormally(out.reason), false, "a real cap is worth naming");
});

test("a floor leaves an explicit override below it alone", () => {
  const out = decide({
    ...base,
    prompt: "use haiku to fix this typo",
    jev: sure("opus"),
    policy: { minAutoTier: "sonnet" },
  });
  assert.equal(out.tier, "haiku");
  assert.equal(out.reason, "override");
});

test("a floor does not raise a tier the guards decided to hold", () => {
  const out = decide({
    ...base,
    current: "haiku",
    jev: sure("haiku"),
    contextTokens: 80000,
    policy: { minAutoTier: "sonnet" },
  });
  assert.equal(out.tier, "sonnet", "holding at the same rank is not a downgrade, so the floor applies");
  const held = decide({ ...base, current: "haiku", jev: null, policy: { minAutoTier: "sonnet" } });
  assert.equal(held.tier, "haiku", "but a Jev failure keeps whatever the user is already on");
});

test("a floor leaves a choice at or above it untouched", () => {
  const out = decide({ ...base, jev: sure("opus"), policy: { minAutoTier: "sonnet" } });
  assert.equal(out.tier, "opus");
  assert.equal(out.reason, "jev");
});

test("routes strong work to the configured tier instead", () => {
  const out = decide({ ...base, jev: sure("opus"), policy: { strongTier: "fable" } });
  assert.equal(out.tier, "fable");
  assert.match(out.reason, /strong/);
});

test("a configured strong tier leaves every other choice alone", () => {
  const out = decide({ ...base, jev: sure("sonnet"), policy: { strongTier: "fable" } });
  assert.equal(out.tier, "sonnet");
  assert.equal(out.reason, "jev/no-change");
});

test("a configured strong tier leaves an explicit opus override alone", () => {
  const out = decide({
    ...base,
    prompt: "use opus for this",
    jev: sure("sonnet"),
    policy: { strongTier: "fable" },
  });
  assert.equal(out.tier, "opus");
  assert.equal(out.reason, "override");
});

test("a tier shift relabels the whole ladder one rung up", () => {
  const shifted = (choice) => decide({ ...base, jev: sure(choice), policy: { tierShift: 1 } });
  assert.deepEqual(shifted("haiku"), {
    tier: "sonnet",
    reason: "jev+shift/no-change",
    changed: false,
  });
  assert.deepEqual(shifted("sonnet"), { tier: "opus", reason: "jev+shift", changed: true });
  assert.deepEqual(shifted("opus"), { tier: "fable", reason: "jev+shift", changed: true });
  assert.deepEqual(shifted("fable"), { tier: "fable", reason: "jev", changed: true });
});

test("a tier shift stops at the top tier the account can run", () => {
  const available = ["haiku", "sonnet", "opus"];
  const out = decide({ ...base, jev: sure("opus"), available, policy: { tierShift: 1 } });
  assert.equal(out.tier, "opus", "a shift must not step into a tier the account has not enabled");
  assert.equal(out.reason, "jev");
  const two = decide({ ...base, jev: sure("haiku"), available, policy: { tierShift: 2 } });
  assert.deepEqual(two, { tier: "opus", reason: "jev+shift", changed: true });
});

test("a tier shift applies after the strong substitution", () => {
  const policy = { strongTier: "fable", tierShift: 1 };
  assert.deepEqual(decide({ ...base, jev: sure("opus"), policy }), {
    tier: "fable",
    reason: "jev+strong",
    changed: true,
  });
  assert.deepEqual(decide({ ...base, jev: sure("sonnet"), policy }), {
    tier: "opus",
    reason: "jev+shift",
    changed: true,
  });
});

test("a tier shift raises the low-confidence ceiling with it", () => {
  // The ceiling is written in the guidance's own vocabulary ("the balanced tier"), so it has
  // to move with the ladder or a weak signal would keep coding work on the rung below.
  const out = decide({ ...base, jev: unsure("sonnet"), policy: { tierShift: 1 } });
  assert.deepEqual(out, { tier: "opus", reason: "jev+shift", changed: true });
  // But a weak signal still must not reach the paid tier: the shift is declined, and what
  // is left is Jev's own answer, so nothing is reported as capped.
  const capped = decide({ ...base, jev: unsure("opus"), policy: { tierShift: 1 } });
  assert.deepEqual(capped, { tier: "opus", reason: "jev", changed: true });
});

test("a larger tier shift still keeps a weak signal out of the paid tier", () => {
  // The shifted ceiling stops one rung below fable however far the ladder moved. Landing
  // there is a cap when it moved Jev's answer, and merely a declined shift when it did not.
  for (const [tierShift, choice] of [[2, "sonnet"], [2, "opus"], [3, "haiku"]]) {
    const out = decide({ ...base, current: "haiku", jev: unsure(choice), policy: { tierShift } });
    assert.equal(out.tier, "opus", `shift ${tierShift}, unsure ${choice}`);
    assert.equal(out.reason, choice === "opus" ? "jev" : "low-confidence-capped", `unsure ${choice}`);
  }
});

test("a weak signal policy would have raised stays on Jev's own tier, unreported", () => {
  // JEV_STRONG_TIER=fable on an opus session: the weak opus answer is substituted to fable
  // and the ceiling brings it back to opus, which is what Jev said. Nothing was capped in
  // effect, so the turn is not annotated as held, and Jev's exact version choice stands as
  // it does upstream.
  const policy = { strongTier: "fable" };
  const out = decide({ ...base, current: "opus", jev: unsure("opus"), policy });
  assert.deepEqual(out, { tier: "opus", reason: "jev/no-change", changed: false });
  assert.equal(shouldUseExactModel(out.reason, "opus", out.tier), true);
  // A cap that moves Jev's own answer is still a cap.
  const capped = decide({ ...base, current: "haiku", jev: unsure("opus"), policy });
  assert.deepEqual(capped, { tier: "sonnet", reason: "low-confidence-capped", changed: true });
});

test("substitutions that cancel out leave Jev's answer standing", () => {
  // A strong tier below the guidance's own, shifted back up: opus → sonnet → opus.
  const policy = { strongTier: "sonnet", tierShift: 1 };
  const out = decide({ ...base, jev: sure("opus"), policy });
  assert.deepEqual(out, { tier: "opus", reason: "jev", changed: true });
  assert.equal(shouldUseExactModel(out.reason, "opus", out.tier), true);
});

test("a tier shift leaves an explicit override alone", () => {
  const out = decide({
    ...base,
    prompt: "use haiku to fix this typo",
    jev: sure("opus"),
    policy: { tierShift: 1 },
  });
  assert.equal(out.tier, "haiku");
  assert.equal(out.reason, "override");
});

test("a tier shift does not raise a tier the guards decided to hold", () => {
  const held = decide({ ...base, current: "haiku", jev: null, policy: { tierShift: 1 } });
  assert.equal(held.tier, "haiku", "a Jev failure keeps whatever the user is already on");
  const cached = decide({
    ...base,
    current: "fable",
    jev: sure("haiku"),
    contextTokens: 80000,
    policy: { tierShift: 1 },
  });
  assert.equal(cached.tier, "fable", "the cache-rebuild guard still holds a shifted downgrade");
  assert.match(cached.reason, /cache-rebuild/);
});

test("every tier records its context window", () => {
  // Sonnet 5, Opus 5 and Fable 5.1 all take 1M input tokens; only Haiku 4.5 is still 200K.
  for (const tier of TIERS) {
    assert.equal(tier.contextWindow, tier.name === "haiku" ? 200000 : 1000000, tier.name);
  }
  assert.equal(contextWindowOf("claude-sonnet-5"), 1000000);
  assert.equal(contextWindowOf("claude-haiku-4-5-20251001"), 200000);
  assert.equal(contextWindowOf("gpt-5.6-luna"), 200000, "an unknown model gets the smallest");
});

const WINDOWS = { haiku: 200000, sonnet: 1000000, opus: 1000000, fable: 1000000 };

test("never downgrades into a model the estimate says the conversation has outgrown", () => {
  // `contextTokens` counts messages only, so it is a floor on what the API would see.
  const policy = { downgradeCutoffTokens: 1000000 };
  const at = (contextTokens, exactWindow) =>
    ({ ...base, current: "opus", contextTokens, windows: WINDOWS, exactWindow, policy });
  const out = decide({ ...at(250000, 200000), jev: sure("haiku") });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /exceeds-window/);
  const fits = decide({ ...at(250000, 1000000), jev: sure("sonnet") });
  assert.equal(fits.tier, "sonnet", "a downgrade into a model with room is still fine");
  const small = decide({ ...at(150000, 200000), jev: sure("haiku") });
  assert.equal(small.tier, "haiku", "and so is one that still fits the smaller window");
  const exact = decide({ ...at(200000, 200000), jev: sure("haiku") });
  assert.equal(exact.tier, "haiku", "nor one exactly the size of the window");
});

test("a caller that measures no windows gets no window guard", () => {
  // The Codex proxy passes none, and keeps the shipped behaviour that way: its models are
  // not Claude's tiers, so Claude's windows must not be applied to them.
  const policy = { downgradeCutoffTokens: 1000000 };
  const out = decide({ ...base, current: "opus", jev: sure("haiku"), requestTokens: 500000, policy });
  assert.deepEqual(out, { tier: "haiku", reason: "jev", changed: true });
  // Saying so with a null rather than by leaving the field out has to survive too, since a
  // parameter default only covers `undefined`. Checked on the branch that actually reads the
  // table: a tier the guards chose, which is not Jev's own answer.
  const capped = { ...base, current: "haiku", jev: unsure("fable"), requestTokens: 500000, policy };
  const expected = { tier: "sonnet", reason: "low-confidence-capped", changed: true };
  assert.deepEqual(decide(capped), expected);
  assert.deepEqual(decide({ ...capped, windows: null }), expected);
});

test("the window guard follows the model the proxy would actually send", () => {
  // A floored answer that lands on the current tier keeps the current model, so the newest
  // catalog entry's window is beside the point.
  const policy = { minAutoTier: "sonnet", downgradeCutoffTokens: 1000000 };
  const out = decide({
    ...base,
    jev: sure("haiku"),
    requestTokens: 250000,
    windows: { haiku: 200000, sonnet: 200000 },
    policy,
  });
  assert.deepEqual(out, { tier: "sonnet", reason: "jev+floor/no-change", changed: false });
});

test("a zero cutoff still lets the first decision of a session downgrade", () => {
  // Before the first decision there is no cache to lose; `cached` says whether there is.
  const first = { ...base, current: "opus", jev: sure("haiku"), policy: { downgradeCutoffTokens: 0 } };
  assert.deepEqual(decide({ ...first, cached: false }), { tier: "haiku", reason: "jev", changed: true });
  assert.match(decide({ ...first, cached: true }).reason, /cache-rebuild/);
  assert.match(decide(first).reason, /cache-rebuild/, "and a caller that says nothing is assumed cached");
});

test("the window guard sizes the whole request when the caller measures it", () => {
  // Claude Code's system prompt and tool schemas ride along with the messages; the messages
  // alone can fit a window the full request no longer does.
  const policy = { downgradeCutoffTokens: 1000000 };
  const measured = { ...base, current: "opus", contextTokens: 150000, windows: WINDOWS, exactWindow: 200000, policy };
  const input = { ...measured, jev: sure("haiku") };
  assert.equal(decide({ ...input, requestTokens: 210000 }).tier, "opus");
  assert.match(decide({ ...input, requestTokens: 210000 }).reason, /exceeds-window/);
  assert.equal(decide({ ...input, requestTokens: 190000 }).tier, "haiku");
  assert.equal(decide(input).tier, "haiku", "unmeasured, the messages are all there is to go on");
});

test("the window guard uses the window of the model that would actually run", () => {
  // Every current Sonnet takes 1M tokens, but the account's catalog may still list an older
  // 200K version, and Jev is told to treat versions as separate choices. When policy accepts
  // Jev's exact choice, that is the model on the wire, so its own window is the one checked.
  const policy = { downgradeCutoffTokens: 1000000 };
  const input = { ...base, current: "opus", jev: sure("sonnet"), requestTokens: 250000, policy };
  const windows = { sonnet: 1000000 };
  assert.equal(decide({ ...input, windows, exactWindow: 200000 }).tier, "opus");
  assert.match(decide({ ...input, windows, exactWindow: 200000 }).reason, /exceeds-window/);
  assert.equal(decide({ ...input, windows, exactWindow: 1000000 }).tier, "sonnet");
  // The tier's window is never substituted for an exact choice the caller did not measure:
  // the newest entry can take five times what the version Jev picked does, so standing in for
  // it would size the request against a model that is not the one going out, and let through
  // exactly what the guard exists to refuse.
  const unmeasured = decide({ ...input, windows: { sonnet: 200000 } });
  assert.deepEqual(unmeasured, { tier: "sonnet", reason: "jev", changed: true });
  assert.equal(decide(input).tier, "sonnet", "and with nothing measured at all, nothing is refused");
});

test("an exact choice that is the model already running is not a move", () => {
  // The caller withholds the exact window when Jev picked the model in use; the tier's own
  // window must not stand in, or a request that model cannot hold would be reported as a
  // refused switch when nothing was switched.
  const out = decide({
    ...base,
    current: "opus",
    jev: sure("opus"),
    requestTokens: 500000,
    windows: { opus: 200000 },
    policy: { downgradeCutoffTokens: 1000000 },
  });
  assert.deepEqual(out, { tier: "opus", reason: "jev/no-change", changed: false });
});

test("a tier reached by policy rather than by Jev's exact choice is sized by its own model", () => {
  // A shifted answer runs on the tier above Jev's, whose newest entry is what goes out, so
  // the window of the exact model Jev chose is beside the point — and the newest entry's
  // window is what has to hold the request.
  const policy = { tierShift: 1 };
  const input = { ...base, jev: sure("sonnet"), requestTokens: 500000, policy };
  const out = decide({ ...input, windows: { opus: 1000000 }, exactWindow: 200000 });
  assert.deepEqual(out, { tier: "opus", reason: "jev+shift", changed: true });
  const held = decide({ ...input, windows: { opus: 200000 }, exactWindow: 1000000 });
  assert.deepEqual(held, { tier: "sonnet", reason: "exceeds-window/no-change", changed: false });
});

test("an explicit override is sent as asked even where it will not fit", () => {
  // The user's own call: a hold would silently contradict it, so the API's refusal is the
  // honest outcome, as upstream has it.
  const out = decide({
    ...base,
    prompt: "use haiku for this",
    current: "opus",
    jev: sure("opus"),
    requestTokens: 500000,
    windows: { haiku: 200000 },
  });
  assert.deepEqual(out, { tier: "haiku", reason: "override", changed: true });
});

test("a model the request has outgrown is refused whichever way the tier moves", () => {
  const policy = { downgradeCutoffTokens: 1000000 };
  // Same tier, but Jev's exact choice is an older 200K catalog entry.
  const same = decide({
    ...base,
    current: "opus",
    jev: sure("opus"),
    requestTokens: 500000,
    windows: { opus: 1000000 },
    exactWindow: 200000,
    policy,
  });
  assert.equal(same.tier, "opus");
  assert.match(same.reason, /exceeds-window/);
  assert.equal(shouldUseExactModel(same.reason, "opus", "opus"), false, "so the exact id is unused");
  // An upgrade into a small-window entry.
  const up = decide({
    ...base,
    current: "sonnet",
    jev: sure("opus"),
    requestTokens: 250000,
    windows: { opus: 1000000 },
    exactWindow: 200000,
    policy,
  });
  assert.deepEqual(up, { tier: "sonnet", reason: "exceeds-window/no-change", changed: false });
  // A hold keeps the model already in use, which is not re-checked.
  const windows = { opus: 200000 };
  const held = decide({ ...base, current: "opus", jev: null, requestTokens: 500000, windows });
  assert.equal(held.reason, "jev-unavailable/no-change");
});

test("the window guard also fires under the shipped cutoff when the request is too big", () => {
  // The cutoff gates the messages; the guard gates the whole request. Upstream would send
  // this to Haiku and have the API reject it, the one place the defaults deliberately differ.
  const input = { ...base, current: "opus", jev: sure("haiku"), contextTokens: 15000, windows: WINDOWS, exactWindow: 200000 };
  const out = decide({ ...input, requestTokens: 210000 });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /exceeds-window/);
});

test("a refusal the current tier cannot take lands on one the estimate says fits, or on nothing", () => {
  // `current` starts at the shipped baseline, which an account's catalog may not carry, so the
  // hold clamps to the nearest tier it does — and that one has a measured window to check.
  const windows = { haiku: 200000, sonnet: 1000000 };
  const input = { ...base, current: "opus", jev: sure("haiku"), requestTokens: 500000 };
  const roomier = decide({ ...input, available: ["haiku", "sonnet"], windows, exactWindow: 200000 });
  assert.deepEqual(roomier, { tier: "sonnet", reason: "exceeds-window+unavailable", changed: true });
  // When nothing the account can run fits either, refusing buys nothing, so the resolved
  // outcome goes out exactly as it would without the guard.
  const nothing = decide({ ...input, available: ["haiku"], windows: { haiku: 200000 }, exactWindow: 200000 });
  assert.equal(nothing.tier, "haiku", "the clamped outcome stands");
  assert.doesNotMatch(nothing.reason, /exceeds-window/, "and is not reported as a refused switch");
  // A request exactly the size of the tier the hold clamps to still fits it.
  const exactFit = decide({ ...input, available: ["haiku", "sonnet"], windows: { haiku: 200000, sonnet: 500000 }, exactWindow: 200000 });
  assert.deepEqual(exactFit, { tier: "sonnet", reason: "exceeds-window+unavailable", changed: true });
  // The clamped tier may have no measured window of its own — a caller can supply windows
  // for some tiers and not others, the same partial measurement `windows` allows throughout.
  // Unmeasured there is unchecked there too, same as for the outcome's own tier.
  const unmeasured = decide({ ...input, available: ["haiku", "sonnet"], windows: { haiku: 200000 }, exactWindow: 200000 });
  assert.deepEqual(unmeasured, { tier: "sonnet", reason: "exceeds-window+unavailable", changed: true });
});

test("a floor set at fable is the user's explicit ask, so a weak signal may land there", () => {
  const policy = { minAutoTier: "fable" };
  const out = decide({ ...base, current: "haiku", jev: unsure("haiku"), policy });
  assert.deepEqual(out, { tier: "fable", reason: "jev+floor", changed: true });
});

test("the strong tier the guidance names is the default substitute", () => {
  assert.equal(GUIDANCE_STRONG_TIER, "opus");
  assert.equal(DEFAULT_POLICY.strongTier, GUIDANCE_STRONG_TIER);
});

test("decide falls back to the shipped default for a policy field it cannot use", () => {
  const strong = { ...base, jev: sure("opus") };
  for (const policy of [{ strongTier: "gpt-9" }, { strongTier: undefined }, { strongTier: null }]) {
    const out = decide({ ...strong, policy });
    assert.deepEqual(out, { tier: "opus", reason: "jev", changed: true }, JSON.stringify(policy));
  }
  for (const policy of [{ tierShift: -1 }, { tierShift: 1.5 }, { tierShift: "1" }]) {
    const out = decide({ ...strong, policy });
    assert.deepEqual(out, { tier: "opus", reason: "jev", changed: true }, JSON.stringify(policy));
  }
  const long = { ...base, current: "opus", jev: sure("haiku"), contextTokens: 80000 };
  for (const policy of [{ downgradeCutoffTokens: null }, { downgradeCutoffTokens: "999999" }]) {
    const out = decide({ ...long, policy });
    assert.equal(out.tier, "opus", `${JSON.stringify(policy)} is neither a cutoff of zero nor a number`);
    assert.match(out.reason, /cache-rebuild/);
  }
});

test("policyFromEnv reads all four knobs", () => {
  const out = withEnv(
    {
      JEV_STRONG_TIER: "fable",
      JEV_MIN_AUTO_TIER: "sonnet",
      JEV_DOWNGRADE_CUTOFF_TOKENS: "200000",
      JEV_TIER_SHIFT: "1",
    },
    () => policyFromEnv(),
  );
  assert.deepEqual(out, {
    strongTier: "fable",
    minAutoTier: "sonnet",
    downgradeCutoffTokens: 200000,
    tierShift: 1,
  });
});

test("a configured strong tier the account cannot run is ignored, not clamped every turn", () => {
  const available = ["haiku", "sonnet", "opus"];
  const out = decide({ ...base, available, jev: sure("opus"), policy: { strongTier: "fable" } });
  assert.deepEqual(out, { tier: "opus", reason: "jev", changed: true });
});

test("a floor the account cannot run is ignored, not clamped every turn", () => {
  const available = ["haiku", "sonnet", "opus"];
  const out = decide({ ...base, available, jev: sure("haiku"), policy: { minAutoTier: "fable" } });
  assert.deepEqual(out, { tier: "haiku", reason: "jev", changed: true });
});

test("policyFromEnv falls back to the shipped defaults on unusable values", () => {
  for (const value of ["", "   ", "gpt-9"]) {
    const out = withEnv(
      {
        JEV_STRONG_TIER: value,
        JEV_MIN_AUTO_TIER: value,
        JEV_DOWNGRADE_CUTOFF_TOKENS: value,
        JEV_TIER_SHIFT: value,
      },
      () => policyFromEnv(),
    );
    assert.deepEqual(out, DEFAULT_POLICY, `value ${JSON.stringify(value)} should fall back`);
  }
  for (const value of ["not-a-number", "-1"]) {
    const out = withEnv({ JEV_DOWNGRADE_CUTOFF_TOKENS: value }, () => policyFromEnv());
    assert.equal(out.downgradeCutoffTokens, DEFAULT_POLICY.downgradeCutoffTokens);
  }
  // A shift is a whole number of rungs on a four-rung ladder; anything else is a typo.
  for (const value of ["-1", "1.5", "4", "abc"]) {
    const out = withEnv({ JEV_TIER_SHIFT: value }, () => policyFromEnv());
    assert.equal(out.tierShift, 0, `shift ${JSON.stringify(value)} should fall back`);
  }
});

test("a configured substitution still counts as routing doing the obvious thing", () => {
  for (const reason of [
    "jev",
    "jev/no-change",
    "jev+strong",
    "jev+floor",
    "jev+strong+floor",
    "jev+shift",
    "jev+shift+floor",
  ]) {
    assert.equal(routedNormally(reason), true, `${reason} should not be annotated as held`);
  }
  for (const reason of [
    "jev+strong+unavailable",
    "low-confidence-capped",
    "downgrade-not-worth-cache-rebuild/no-change",
    "jev-unavailable",
  ]) {
    assert.equal(routedNormally(reason), false, `${reason} is worth naming`);
  }
});

test("the reason vocabulary the status line loads has no dependencies", () => {
  // The status line runs on every render; it must not pull the SDK in behind config.mjs.
  const source = readFileSync(new URL("../src/reason.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^import /m);
});

test("decide stays a pure function of its arguments", () => {
  const call = () => decide({ ...base, current: "opus", jev: sure("haiku"), contextTokens: 80000 });
  const before = call();
  const during = withEnv(
    {
      JEV_STRONG_TIER: "fable",
      JEV_MIN_AUTO_TIER: "fable",
      JEV_DOWNGRADE_CUTOFF_TOKENS: "999999",
      JEV_TIER_SHIFT: "1",
    },
    call,
  );
  assert.deepEqual(during, before, "the environment must not reach decide() behind the caller's back");
});
