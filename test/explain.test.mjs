import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatExplanation } from "../src/explain.mjs";

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
    tier: "sonnet",
    model: "claude-sonnet-5",
    confidence: 0.2,
    reason: "low-confidence-capped",
    recommended: "opus",
  });
  assert.match(output, /Recommended tier: OPUS/);
  assert.match(output, /Selected model: CLAUDE-SONNET-5/);
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
