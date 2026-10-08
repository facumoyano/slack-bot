import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSchema, toTarget } from "../src/resolve.ts";

test("the schema only lets Claude pick a known repo or null", () => {
  const schema = resolveSchema([{ owner: "fyso-dev", name: "fyso_backend" }]) as { properties: { repo: { enum: unknown[] } } };
  assert.deepEqual(schema.properties.repo.enum, ["fyso-dev/fyso_backend", null]);
});

test("Claude's answer becomes a target with an issue URL, and null means no target", () => {
  assert.deepEqual(toTarget({ repo: "fyso-dev/fyso_backend", issue: 1717 }), {
    owner: "fyso-dev",
    name: "fyso_backend",
    issue: { number: 1717, url: "https://github.com/fyso-dev/fyso_backend/issues/1717" },
  });
  assert.deepEqual(toTarget({ repo: "fyso-dev/fyso-business", issue: null }), { owner: "fyso-dev", name: "fyso-business", issue: undefined });
  assert.equal(toTarget({ repo: null, issue: null }), undefined);
});
