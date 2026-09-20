// The vocabulary of routing reasons `decide()` produces, kept apart from the policy itself
// and free of imports on purpose: the status line is spawned by Claude Code on every render,
// and loading the SDK behind config.mjs for a three-line string predicate measured +24 ms
// cold per invocation.

/** Notes a `jev` reason carries for policy the user configured, rather than a routing exception. */
export const POLICY_NOTES = ["strong", "shift", "floor"];

/** The parts of a reason `decide()` produced, without the `/no-change` suffix. */
const reasonParts = (reason = "") => reason.replace(/\/no-change$/, "").split("+");

/** The policy notes a reason carries, in the order they were applied. */
export const policyNotesOf = (reason) =>
  reasonParts(reason).filter((part) => POLICY_NOTES.includes(part));

/**
 * Whether a reason describes routing doing the obvious thing. Applying a configured
 * substitution counts as obvious; a guard, an unavailable tier, or a failure does not.
 *
 * Lives here, next to the vocabulary `decide()` produces, so that display code does not have
 * to keep its own copy of the reason strings and quietly fall out of date when one is added.
 */
export const routedNormally = (reason) =>
  reasonParts(reason).every((part) => part === "jev" || POLICY_NOTES.includes(part));
