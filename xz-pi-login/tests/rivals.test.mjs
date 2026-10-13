import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findRivals, packageNameOf } from "../lib/rivals.js";

describe("rivals", () => {
  it("reads npm, path, and git sources by package name", () => {
    assert.equal(packageNameOf("npm:pi-multi-account"), "pi-multi-account");
    assert.equal(packageNameOf("npm:@hu3rror/pi-failover"), "@hu3rror/pi-failover");
    assert.equal(packageNameOf("packages/pi-supernova"), "pi-supernova");
    assert.equal(
      packageNameOf("../../Developer/pi-stack/packages/xz-pi-login"),
      "xz-pi-login",
    );
    assert.equal(packageNameOf("git:github.com/u/pi-failover"), "pi-failover");
    assert.equal(packageNameOf(""), "");
    assert.equal(packageNameOf(null), "");
    assert.equal(packageNameOf(undefined), "");
  });

  it("flags known balancers and dedupes", () => {
    assert.deepEqual(
      findRivals([
        "packages/pi-supernova",
        "npm:pi-failover",
        "npm:@henryqw/pi-multi-codex",
        "npm:pi-failover",
      ]),
      ["pi-failover", "@henryqw/pi-multi-codex"],
    );
  });

  it("treats legacy account routers as rivals in standalone mode", () => {
    assert.deepEqual(findRivals(["npm:pi-rotator"]), ["pi-rotator"]);
    assert.deepEqual(findRivals(["npm:pi-multi-account"]), ["pi-multi-account"]);
    assert.deepEqual(findRivals(["npm:@jischeng/pi-multi-account"]), ["@jischeng/pi-multi-account"]);
  });

  it("ignores itself and everything else", () => {
    assert.deepEqual(findRivals(["../../x/packages/xz-pi-login", "npm:pi-web-access"]), []);
    assert.deepEqual(findRivals(null), []);
  });

  it("survives junk sources from hand-edited settings", () => {
    assert.equal(packageNameOf(42), "");
    assert.equal(packageNameOf({}), "");
    assert.equal(packageNameOf(true), "");
    assert.deepEqual(
      findRivals([42, null, {}, ["npm:pi-failover"], "npm:pi-failover"]),
      ["pi-failover"],
    );
  });
});

it("sweep: git sources preserve rival identity without reinterpreting local path names", () => {
  const sources = ["git:github.com/example/pi-failover@v1", "https://github.com/example/pi-failover.git#feature/topic", "ssh://git@github.com/example/pi-failover.git@v1"];

  for (const source of sources) assert.deepEqual(findRivals([source]), ["pi-failover"], source);
  assert.deepEqual(findRivals(sources), ["pi-failover"]);
  assert.deepEqual(findRivals(["/local/pi-failover@v1", "/local/pi-failover.git"]), [], "local filenames are literal, not repository URLs");
  assert.equal(packageNameOf("https://[malformed"), "");
});
