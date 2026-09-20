// Every routing decision knob lives here, so the whole policy is reviewable in one file.
import { choice, score } from "@typesafe-ai/sdk";

/**
 * Model tiers, cheapest first. `id` is what goes into the API request body; `family` is the
 * substring used to recognise whatever model Claude Code asked for, which may be an older
 * version within the same tier such as `claude-sonnet-4-6`. The capability flags come from
 * the Agent SDK's model catalogue: Haiku supports neither adaptive thinking nor effort, so
 * those fields have to be stripped when routing down to it. `contextWindow` is the input
 * limit the Models API reports as `max_input_tokens`: 1M for Sonnet 5, Opus 5 and Fable 5.1,
 * while Haiku 4.5 is still 200K.
 */
export const TIERS = [
  { name: "haiku", id: "claude-haiku-4-5-20251001", family: "haiku", thinking: false, effort: false, contextWindow: 200000 },
  { name: "sonnet", id: "claude-sonnet-5", family: "sonnet", thinking: true, effort: true, contextWindow: 1000000 },
  { name: "opus", id: "claude-opus-5", family: "opus", thinking: true, effort: true, contextWindow: 1000000 },
  { name: "fable", id: "claude-fable-5-1", family: "fable", thinking: true, effort: true, contextWindow: 1000000 },
];

export const TIER_NAMES = TIERS.map((t) => t.name);

export const rankOf = (name) => TIER_NAMES.indexOf(name);

export const idOf = (name) => TIERS.find((t) => t.name === name)?.id;

export const tierSpec = (name) => TIERS.find((t) => t.name === name);

/**
 * Sentinel model id offered as an extra row in Claude Code's /model picker. Claude Code
 * sends it verbatim because it does not validate model names behind a custom base URL, so
 * its presence in a request is an exact signal that the user wants this turn routed. Any
 * other model means the user picked one themselves and it must be passed straight through.
 */
export const AUTO_MODEL = "jev-router";

/** Whether a request should be routed, or passed through as the user's own choice. */
export const isAuto = (model) => model === AUTO_MODEL;

/** Tier name for a model string Claude Code sent, or null if we don't recognise it. */
export const tierOf = (model) =>
  TIERS.find((t) => typeof model === "string" && model.includes(t.family))?.name ?? null;

/**
 * Context window of the tier a model string belongs to. A model we do not recognise gets
 * the smallest window we run, so an unknown model is never reported as having more room
 * than it might.
 */
export const contextWindowOf = (model) =>
  tierSpec(tierOf(model))?.contextWindow ?? Math.min(...TIERS.map((t) => t.contextWindow));

/**
 * Fable bills extra usage credits, so it is opt-in. Everything else is covered by a normal
 * subscription.
 */
export const availableTiers = () =>
  TIER_NAMES.filter((n) => n !== "fable" || process.env.JEV_ALLOW_FABLE === "1");

export const THRESHOLDS = {
  /** Below this Jev confidence we refuse to downgrade and cap upgrades at `uncertainCeiling`. */
  minConfidence: 0.3,
  /** Safest tier to land on when Jev is unsure. */
  uncertainCeiling: "sonnet",
  /**
   * Switching models invalidates the prompt cache; the next turn re-sends the whole
   * conversation. Measured at ~23.6k cache-creation tokens switching into Opus, so a
   * downgrade only pays off while the conversation is still small. Default for
   * `JEV_DOWNGRADE_CUTOFF_TOKENS`; see `downgradeCutoffTokens`.
   */
  downgradeMaxContextTokens: 20000,
  /**
   * Per-attempt Jev HTTP timeout and the hard wall-clock deadline for the whole routing
   * call. Measured: ~300-350ms warm, ~900-1000ms on the first call (TLS handshake), so the
   * deadline leaves room for one retry after a cold-start timeout.
   */
  jevTimeoutMs: 1500,
  jevDeadlineMs: 3000,
  jevMaxRetries: 1,
};

/**
 * The tier `GUIDANCE` describes as "strong": what `JEV_STRONG_TIER` substitutes another tier
 * for. Named apart from the policy default it happens to equal, because the two play
 * different roles — this one is matched against Jev's answer, the default is what runs.
 */
export const GUIDANCE_STRONG_TIER = "opus";

/** What `decide()` applies when the caller passes no policy: exactly the shipped behaviour. */
export const DEFAULT_POLICY = Object.freeze({
  strongTier: GUIDANCE_STRONG_TIER,
  minAutoTier: null,
  downgradeCutoffTokens: THRESHOLDS.downgradeMaxContextTokens,
  tierShift: 0,
});

/**
 * `policy` with every missing or unusable field replaced by its shipped default. Both
 * `decide()` and `policyFromEnv` go through this, so neither a bad environment value nor a
 * caller handing over a half-built object can switch a guard off: an unknown tier name, a
 * negative or fractional shift, or a cutoff that is not a number all mean "as shipped".
 */
export const normalizePolicy = (policy) => {
  const given = policy ?? {};
  const tier = (name, fallback) => (TIER_NAMES.includes(name) ? name : fallback);
  const { downgradeCutoffTokens: cutoff, tierShift: shift } = given;
  return {
    strongTier: tier(given.strongTier, DEFAULT_POLICY.strongTier),
    minAutoTier: tier(given.minAutoTier, DEFAULT_POLICY.minAutoTier),
    downgradeCutoffTokens:
      typeof cutoff === "number" && Number.isFinite(cutoff) && cutoff >= 0
        ? cutoff
        : DEFAULT_POLICY.downgradeCutoffTokens,
    tierShift:
      Number.isInteger(shift) && shift >= 0 && shift < TIER_NAMES.length
        ? shift
        : DEFAULT_POLICY.tierShift,
  };
};

/**
 * The optional routing knobs, read from the environment.
 *
 * Built by the caller on each request rather than at module load, because the launcher loads
 * its environment files after this module is first evaluated — but passed into `decide()`
 * rather than read inside it, so the policy stays a pure function of its arguments and the
 * Codex proxy keeps the shipped behaviour simply by not building one.
 *
 * Every field degrades to the shipped default when the variable is absent or unusable, so a
 * typo can never disable a guard:
 *
 * - `JEV_STRONG_TIER` — tier to run the work the guidance calls "strong" on. Whether the
 *   account can run it is settled in `decide()`, which knows what is available; a tier it
 *   cannot run (an opt-in paid tier, say) is ignored rather than clamped on every turn.
 * - `JEV_MIN_AUTO_TIER` — lowest tier automatic routing may land on. An explicit override in
 *   the prompt still reaches any tier, because the human has already made that call. Ignored
 *   in the same way when the account cannot run it.
 * - `JEV_DOWNGRADE_CUTOFF_TOKENS` — context size at or below which an automatic downgrade is
 *   still worth the cache rebuild. A larger value permits downgrades in longer conversations;
 *   `0` turns automatic downgrades off entirely.
 * - `JEV_TIER_SHIFT` — rungs to move every automatic choice up the ladder of tiers the
 *   account can run, so the guidance's "trivial / ordinary / hard" split lands one tier
 *   higher than written. Whole numbers below the ladder's height only; `0` is the default.
 */
export const policyFromEnv = () => {
  const text = (key) => process.env[key]?.trim() || undefined;
  const number = (key) => (text(key) === undefined ? undefined : Number(text(key)));
  return normalizePolicy({
    strongTier: text("JEV_STRONG_TIER")?.toLowerCase(),
    minAutoTier: text("JEV_MIN_AUTO_TIER")?.toLowerCase(),
    downgradeCutoffTokens: number("JEV_DOWNGRADE_CUTOFF_TOKENS"),
    tierShift: number("JEV_TIER_SHIFT"),
  });
};

const COMPLEXITY_SCALE = [
  "None",
  "Very low",
  "Low",
  "Some",
  "Moderate",
  "Moderate to high",
  "High",
  "Very high",
  "Severe",
  "Extreme",
];

export const COMPLEXITY_MAX_SCORE = COMPLEXITY_SCALE.length - 1;

/** Phrases that mean "the human already decided", checked against the raw prompt. */
export const OVERRIDE_PATTERNS = TIERS.map((t) => ({
  tier: t.name,
  re: new RegExp(
    `\\b(?:use|switch to|with|on)\\s+(?:${{
      haiku: "haiku|fast|luna",
      sonnet: "sonnet|balanced|terra",
      opus: "opus|strong|sol",
      fable: "fable|long|astra",
    }[t.name]})\\b`,
    "i",
  ),
}));

export const QUESTIONS = {
  task_complexity: score(
    "How complex is the coding task overall, including ambiguity, scope, and blast radius?",
    COMPLEXITY_SCALE,
  ),
  reasoning_required: score(
    "How much reasoning is required to complete the request correctly in one pass?",
    COMPLEXITY_SCALE,
  ),
  tool_complexity: score(
    "How complex is the tool use required, from no tools to many coordinated or stateful operations?",
    COMPLEXITY_SCALE,
  ),
};

const GUIDANCE = {
  haiku: {
    what: "Trivial, mechanical, or purely factual work.",
    signals: ["Rename, reformat, comment, or run one obvious command"],
    not_for: "Design judgement or multi-file reasoning.",
  },
  sonnet: {
    what: "Ordinary day-to-day engineering with a clear, bounded shape.",
    signals: ["Implement a specified function, test existing behaviour, or fix an understood local bug"],
    not_for: "Open-ended architecture, subtle concurrency, or unknown-cause debugging.",
  },
  opus: {
    what: "Hard reasoning, ambiguity, or high blast radius.",
    signals: ["Unknown-cause debugging, cross-module design, security, auth, concurrency, or migrations"],
    not_for: "Routine work with a clear implementation.",
  },
  fable: {
    what: "Very large or long-running work beyond a normal focused session.",
    signals: ["Whole-repo migration, unusually large context, or multi-hour autonomous execution"],
    not_for: "Anything a strong model can finish in one focused session.",
  },
};

/** Build a Jev choice from the exact models available to this account and CLI. */
export const questionForModels = (models) =>
  choice(
    [
      "Pick the cheapest exact model that can fully complete this coding request in one pass, without retrying on a stronger model.",
      "Treat different model versions as separate choices. Judge required reasoning, not requested reply length.",
    ],
    Object.fromEntries(
      models.map(({ id, tier, description }) => [
        id,
        { model: description ?? id, ...GUIDANCE[tier] },
      ]),
    ),
  );

/** Whether policy accepted Jev's exact model, including a version change within one tier. */
export const shouldUseExactModel = (reason, chosenTier, finalTier) =>
  (reason === "jev" || reason === "jev/no-change") && chosenTier === finalTier;
