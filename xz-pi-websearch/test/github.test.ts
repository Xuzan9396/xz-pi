import test from "node:test";
import assert from "node:assert/strict";
import { parseGitHubUrl } from "../github.ts";

test("parses GitHub repository and content URLs", () => {
  assert.deepEqual(parseGitHubUrl("https://github.com/acme/demo"), {
    owner: "acme", repo: "demo", kind: "repo", parts: [], url: "https://github.com/acme/demo",
  });
  assert.equal(parseGitHubUrl("https://github.com/acme/demo/tree/main/src")?.kind, "tree");
  assert.deepEqual(parseGitHubUrl("https://github.com/acme/demo/blob/main/src/a.ts")?.parts, ["main", "src", "a.ts"]);
  assert.equal(parseGitHubUrl("https://github.com/acme/demo/pull/42")?.number, 42);
  assert.equal(parseGitHubUrl("https://github.com/acme/demo/issues/7")?.kind, "issue");
});

test("ignores non-GitHub and malformed URLs", () => {
  assert.equal(parseGitHubUrl("https://gitlab.com/acme/demo"), undefined);
  assert.equal(parseGitHubUrl("https://github.com/only-owner"), undefined);
});
