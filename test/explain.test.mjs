import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatExplanation } from "../src/explain.mjs";
import { POLICY_NOTES } from "../src/reason.mjs";

test("formats the last routing decision", () => {
  const output = formatExplanation({
    prompt: "Explain the router architecture",
    tier: "sonnet",
    recommended: "sonnet",
    confidence: 0.94,
    reason: "jev",
    jev: {
      request: { state: { session: { current_model: "haiku", context_tokens: 6200 } } },
      response: { answers: { model: { choice: "claude-sonnet-5" } } },
    },
    metrics: {
      taskComplexity: 0.82,
      reasoningRequired: 0.91,
      toolComplexity: 0.64,
      contextSize: 0.31,
    },
  });

  assert.match(output, /Task complexity     0\.82/);
  assert.match(output, /Prompt: Explain the router/);
  assert.match(output, /Current tier: HAIKU/);
  assert.match(output, /Context tokens: 6200/);
  assert.match(output, /Recommended tier: SONNET/);
  assert.match(output, /Selected model: SONNET/);
  assert.match(output, /Confidence: 94%/);
  assert.match(output, /Decision: Jev recommendation/);
});

test("shows the tier Jev recommended even when policy ran something else", () => {
  const output = formatExplanation({
    tier: "fable",
    model: "claude-fable-5-1",
    confidence: 0.8,
    reason: "jev+strong",
    recommended: "opus",
  });
  assert.match(output, /Recommended tier: OPUS/);
  // The panel clips the last character of this id; the row is still unmistakable.
  assert.match(output, /Selected model: CLAUDE-FABLE-5/);
  assert.match(output, /Decision: strong tier swapped/);
  // The tier is recorded at decision time, so a Codex model id needs no mapping here.
  const codex = formatExplanation({
    tier: "sonnet",
    model: "gpt-5.6-terra",
    recommended: "opus",
    confidence: 0.2,
    reason: "low-confidence-capped",
  });
  assert.match(codex, /Recommended tier: OPUS/);
  // The shipped "low confidence; capped" label is one character too wide and is clipped.
  assert.match(codex, /Decision: low confidence; cappe/);
});

test("a decision recorded before the recommended tier was kept still names Jev's choice", () => {
  const older = formatExplanation({
    tier: "sonnet",
    confidence: 0.2,
    reason: "low-confidence-capped",
    jev: { response: { answers: { model: { choice: "claude-opus-5" } } } },
  });
  assert.match(older, /Recommended tier: OPUS/);
});

test("names a configured substitution instead of calling it a plain recommendation", () => {
  // Without this the panel says "Jev recommendation" while its own recommended-tier row
  // names a different tier from the one that ran, which is the divergence it exists to explain.
  const decisionOf = (reason) => formatExplanation({ tier: "fable", confidence: 0.8, reason });
  // Every label has to survive the panel, which clips a long line instead of wrapping it.
  assert.match(decisionOf("jev+strong"), /Decision: strong tier swapped\s+│/);
  assert.match(decisionOf("jev+floor"), /Decision: raised to floor\s+│/);
  assert.match(decisionOf("jev+strong+floor/no-change"), /Decision: swapped, then floor\s+│/);
  assert.match(decisionOf("jev+shift"), /Decision: tier shift applied\s+│/);
  assert.match(decisionOf("jev+strong+shift+floor"), /Decision: tier shift applied\s+│/);
  assert.match(
    decisionOf("exceeds-window/no-change"),
    /Decision: window too small\s+│/,
  );
  // Every note the policy can attach has a label of its own, so a new one cannot fall
  // through to the plain-recommendation wording.
  for (const note of POLICY_NOTES) {
    assert.doesNotMatch(decisionOf(`jev+${note}`), /Jev recommendation/, note);
  }
  // The shipped "low confidence; capped" label is one character too wide for the panel and
  // is already clipped; left alone here rather than reworded as a drive-by change.
  assert.match(decisionOf("jev"), /Decision: Jev recommendation/);
});

test("shows the concrete provider model when available", () => {
  assert.match(
    formatExplanation({ tier: "haiku", model: "gpt-5.6-luna", confidence: 0.99 }),
    /Selected model: GPT-5\.6-LUNA/,
  );
});

test("Claude skill pre-approves its read-only explanation command", () => {
  const skill = readFileSync(new URL("../.claude/skills/jev-explain/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /^allowed-tools: Bash\(node \*\)$/m);
});
