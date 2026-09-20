import {
  TIER_NAMES,
  THRESHOLDS,
  OVERRIDE_PATTERNS,
  GUIDANCE_STRONG_TIER,
  DEFAULT_POLICY,
  rankOf,
  normalizePolicy,
  shouldUseExactModel,
} from "./config.mjs";

/** The tier the user named explicitly in the prompt, or null. */
export function detectOverride(prompt) {
  const hit = OVERRIDE_PATTERNS.find((p) => p.re.test(prompt ?? ""));
  return hit ? hit.tier : null;
}

/**
 * Nearest tier the account can actually run. Prefers stepping up rather than down so we
 * never silently hand a hard task to a weaker model, but never steps up into `fable`
 * (which bills extra usage credits) unless that is what was asked for.
 */
function clampToAvailable(tier, available) {
  if (available.includes(tier)) return tier;
  const rank = rankOf(tier);
  const up = TIER_NAMES.filter(
    (t, i) => i > rank && available.includes(t) && (t !== "fable" || tier === "fable"),
  );
  if (up.length) return up[0];
  const down = TIER_NAMES.filter((t, i) => i < rank && available.includes(t));
  return down.length ? down[down.length - 1] : null;
}

/**
 * Turns a Jev answer into the model we will actually run. Pure and total: any missing,
 * malformed, or unavailable input falls back to the model already in use.
 *
 * @param {object} input
 * @param {string} input.prompt        raw user prompt, for explicit-override detection
 * @param {?{choice: string, confidence: number}} input.jev  null when Jev failed
 * @param {string} input.current       tier currently active in the session
 * @param {string[]} input.available   tier names the account can run
 * @param {number} input.contextTokens approximate size of the conversation so far
 * @param {number} [input.requestTokens] approximate size of the whole request, when the caller
 *                                     measured it; the conversation size otherwise
 * @param {Object<string, number>} [input.windows] context window per tier of the model the
 *                                     caller would send on a change of tier. A tier with no
 *                                     entry is not checked, which is how the Codex proxy,
 *                                     whose models are not Claude's tiers, keeps the shipped
 *                                     behaviour
 * @param {number} [input.exactWindow] context window of the exact model Jev chose, when that
 *                                     is not the model already in use; checked in place of
 *                                     the tier's when the outcome sends that choice
 * @param {boolean} [input.cached]     whether a prompt cache exists to lose; false before a
 *                                     session's first decision
 * @param {object} [input.policy]      optional knobs; see `policyFromEnv`. Omitting it, as the
 *                                     Codex proxy does, gives exactly the shipped behaviour,
 *                                     and so does any field `normalizePolicy` cannot use or a
 *                                     tier the account cannot run.
 * @returns {{tier: string, reason: string, changed: boolean}}
 */
export function decide({
  prompt,
  jev,
  current,
  available,
  contextTokens = 0,
  requestTokens = contextTokens,
  windows = {},
  exactWindow,
  cached = true,
  policy,
}) {
  const given = normalizePolicy(policy);
  // Settled here rather than where the policy is read, because this is the one place that
  // knows what the account can run: a configured tier it cannot would otherwise be clamped
  // to `+unavailable` on every turn instead of simply not applying.
  const runnable = (tier, fallback) => (tier && available.includes(tier) ? tier : fallback);
  const strongTier = runnable(given.strongTier, DEFAULT_POLICY.strongTier);
  const minAutoTier = runnable(given.minAutoTier, null);
  const { downgradeCutoffTokens, tierShift } = given;
  const notes = [];

  const settle = (tier, reason) => {
    const final = clampToAvailable(tier, available) ?? current;
    const why = final === tier ? reason : `${reason}+unavailable`;
    return { tier: final, reason: final === current ? `${why}/no-change` : why, changed: final !== current };
  };

  /**
   * Raises a tier the policy will not route below. Applied to choices only: the guards that
   * hold `current` are not choosing anything, and `current` may be a tier the user asked for.
   */
  const floorUp = (tier) =>
    minAutoTier && rankOf(tier) < rankOf(minAutoTier) ? minAutoTier : tier;

  /**
   * Moves a tier `tierShift` rungs up the ladder of tiers the account can run, stopping at
   * the top. Walking the available tiers rather than all of them is what keeps a shift out
   * of a tier the account has not enabled, so it never needs the clamp in `settle`.
   */
  const ladder = TIER_NAMES.filter((t) => available.includes(t));
  const shiftUp = (tier) => {
    const at = ladder.indexOf(tier);
    return at < 0 ? tier : ladder[Math.min(at + tierShift, ladder.length - 1)];
  };

  const override = detectOverride(prompt);
  if (override) return settle(override, "override");

  const resolve = () => {
    if (!jev || !TIER_NAMES.includes(jev.choice)) return settle(current, "jev-unavailable");

    let target = jev.choice;

    // The substitution runs before the guards below so they compare the tier that will
    // actually run against `current`. The other way round, a session already settled on the
    // configured tier would look like it was flipping back to the guidance's own strong tier
    // every turn.
    if (target === GUIDANCE_STRONG_TIER && strongTier !== target) {
      target = strongTier;
      notes.push("strong");
    }

    const shifted = shiftUp(target);
    if (shifted !== target) {
      target = shifted;
      notes.push("shift");
    }

    const floored = floorUp(target);
    if (floored !== target) {
      target = floored;
      notes.push("floor");
    }

    if (jev.confidence < THRESHOLDS.minConfidence) {
      if (rankOf(target) < rankOf(current)) return settle(current, "low-confidence-no-downgrade");
      // The ceiling is named in the guidance's own vocabulary, so it moves with the ladder —
      // but a shift never carries it into fable: a weak signal must not be what enters the
      // paid tier. A floor may, being the user's explicit ask; it outranks the ceiling, and
      // raising the ceiling to it means the cap fires, and is reported, only when it actually
      // moved the tier.
      const shiftedSafe = rankOf(shiftUp(THRESHOLDS.uncertainCeiling));
      const safe = TIER_NAMES[Math.min(shiftedSafe, rankOf("fable") - 1)];
      const ceiling = floorUp(TIER_NAMES[Math.max(rankOf(current), rankOf(safe))]);
      // A cap that lands on Jev's own answer has declined the substitution rather than
      // capped Jev: the answer stands, exact model included, and nothing is reported as held.
      if (rankOf(target) > rankOf(ceiling)) {
        return settle(ceiling, ceiling === jev.choice ? "jev" : "low-confidence-capped");
      }
    }

    // A cutoff of `0` means never once there is a cache to lose, which the comparison alone
    // would not deliver: at `contextTokens` 0 there is nothing greater than 0 and the
    // downgrade would go ahead. Before the first decision nothing is cached, so a session
    // may still open on the tier Jev picked rather than be pinned to the baseline. `cached`
    // is consulted for the zero cutoff only, a deliberate trade-off: folding it into the
    // comparison as well would let a large first paste downgrade under the shipped cutoff,
    // where upstream holds the baseline, and the defaults are meant to reproduce upstream.
    const cacheRebuildTooExpensive =
      downgradeCutoffTokens === 0 ? cached : contextTokens > downgradeCutoffTokens;
    if (rankOf(target) < rankOf(current) && cacheRebuildTooExpensive) {
      return settle(current, "downgrade-not-worth-cache-rebuild");
    }

    // Substitutions that cancel out — a strong tier below the guidance's own, shifted back
    // up — leave Jev's answer standing, exact model included, and are not reported.
    return settle(target, target === jev.choice ? "jev" : ["jev", ...notes].join("+"));
  };

  const outcome = resolve();

  // Whatever the policy resolved, a model the request has outgrown cannot serve it, so the
  // turn stays on the model already in use — for an upgrade or a same-tier version swap as
  // much as for a downgrade. Only an outcome that puts a new model on the wire is checked,
  // and which model that is follows the same rule the proxy uses to pick it: Jev's exact
  // choice when policy accepted it, the tier's own model otherwise; a hold keeps the current
  // one. Jev's exact choice may be the model already running, which is no move at all;
  // only the caller knows the model ids, so it withholds `exactWindow` in that case and the
  // outcome goes unchecked rather than being reported as held. Reachable under the shipped
  // cutoff too, since the cutoff gates the messages while this gates the whole request:
  // upstream would send such a request and have the API reject it, the one place the
  // shipped behaviour is deliberately not reproduced. An explicit override returned above
  // and is not checked: that is the user's own call.
  const exact = shouldUseExactModel(outcome.reason, jev?.choice, outcome.tier);
  const moved = outcome.tier !== current;
  const window = (exact ? exactWindow : undefined) ?? (moved ? windows[outcome.tier] : undefined);
  if (window !== undefined && requestTokens > window) {
    return settle(current, "exceeds-window");
  }
  return outcome;
}
