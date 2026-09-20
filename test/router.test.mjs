import test from "node:test";
import assert from "node:assert/strict";
import { contextSizeOf } from "../src/router.mjs";

test("context size is measured against the window of the model actually in use", () => {
  // The account's catalog may still list an older 200K Sonnet next to the current 1M one,
  // and the same conversation fills them to very different degrees.
  const models = [
    { id: "claude-sonnet-5", tier: "sonnet", contextWindow: 1000000 },
    { id: "claude-sonnet-4-5", tier: "sonnet", contextWindow: 200000 },
  ];
  assert.equal(contextSizeOf(100000, "claude-sonnet-4-5", models), 0.5);
  assert.equal(contextSizeOf(100000, "claude-sonnet-5", models), 0.1);
  assert.equal(contextSizeOf(100000, "claude-sonnet-5"), 0.1, "the tier's window when the catalog has no entry");
  assert.equal(contextSizeOf(5000000, "claude-sonnet-5", models), 1, "saturates at a full window");
});

test("a model outside the Claude tiers keeps the 200K the metric was always measured against", () => {
  // The Codex proxy's candidates carry no window; they are not Claude's tiers.
  const codex = [{ id: "gpt-5.6-luna", tier: "haiku" }];
  assert.equal(contextSizeOf(100000, "gpt-5.6-luna", codex), 0.5);
});
