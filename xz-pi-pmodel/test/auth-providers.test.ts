import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { classifyMissingReference, filterAuthenticatedModels, readAuthProviderIds } from "../src/auth-providers.js";

const model = (provider: string, id: string) => ({ provider, id } as Model<any>);

test("auth provider catalog keeps auth.json order and filters the model catalog", () => {
  const dir = mkdtempSync(join(tmpdir(), "pmodel-auth-"));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ work: { token: "secret" }, personal: {} }));
  assert.deepEqual(readAuthProviderIds(dir), ["work", "personal"]);
  assert.deepEqual(filterAuthenticatedModels([model("other", "x"), model("personal", "gpt"), model("work", "gpt")], ["work", "personal"])
    .map(item => `${item.provider}/${item.id}`), ["personal/gpt", "work/gpt"]);
});

test("missing references distinguish deleted providers from deleted models", () => {
  const models = [model("work", "gpt")];
  assert.equal(classifyMissingReference({ provider: "gone", id: "gpt" }, ["work"], models), "provider");
  assert.equal(classifyMissingReference({ provider: "work", id: "gone" }, ["work"], models), "model");
  assert.equal(classifyMissingReference({ provider: "work", id: "gpt" }, ["work"], models), undefined);
});
