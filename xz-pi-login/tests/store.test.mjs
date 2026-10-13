import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRANSIENT_COOLDOWN_MS, coolFailedTurn } from "../lib/observations.js";
import { safeOn } from "../lib/support.js";
import { setAccountAliases } from "../lib/slots.js";

setAccountAliases({
  "cursor-account-2": { base: "cursor", suffix: "account-2" },
  "openai-codex-account-2": { base: "openai-codex", suffix: "account-2" },
  "fixture-account-2": { base: "fixture", suffix: "account-2" },
  "xai-account-2": { base: "xai", suffix: "account-2" },
  "xai-account-3": { base: "xai", suffix: "account-3" },
});
import {
  EXHAUSTED_STATUS,
  SESSION_IDLE_MS,
  appendDebug,
  appendJournal,
  classifyResponse,
  isCooling,
  journalPath,
  markCooling,
  needsBackfill,
  pruneCooldowns,
  pruneSessions,
  recordTurn,
} from "../lib/store.js";

describe("transient cooling", () => {
  it("benches transient flakes briefly while quota keeps the full cooldown", async t => {
    const now = Date.now;
    let clock = 1_000_000;

    Date.now = () => clock;
    t.after(() => { Date.now = now; });
    const dir = mkdtempSync(join(tmpdir(), "rotator-transient-cool-"));
    const family = { base: "cursor", slots: ["cursor", "cursor-account-2"], cooldowns: new Map() };
    const session = {};
    const model = { provider: "cursor", id: "cursor-grok-4.6", api: "openai-completions" };
    const state = { config: { cooldownMs: 21_600_000 } };

    coolFailedTurn(dir, state, family, session, model, { slot: "cursor", modelId: "cursor-grok-4.6", exhausted: false, transient: true, fastRejected: false });
    coolFailedTurn(dir, state, family, session, model, { slot: "cursor-account-2", modelId: "cursor-grok-4.6", exhausted: true, transient: false, fastRejected: false });
    assert.equal(TRANSIENT_COOLDOWN_MS, 300_000);
    assert.equal(family.cooldowns.get("cursor"), 1_000_000 + 300_000);
    assert.equal(family.cooldowns.get("cursor-account-2"), 1_000_000 + 21_600_000);
    const rows = readFileSync(journalPath(dir), "utf8").trim().split("\n").map(line => JSON.parse(line));

    assert.equal(rows[0].cooldownScope, "transient");
    assert.equal(rows[1].cooldownScope, "account");
  });
});

describe("store", () => {
  it("recordTurn counts drain and stamps warmth", () => {
    const drained = new Map();
    const lastActive = new Map();

    recordTurn(drained, lastActive, "openai-codex", 1000);
    recordTurn(drained, lastActive, "openai-codex", 2000);

    assert.equal(drained.get("openai-codex"), 2);
    assert.equal(lastActive.get("openai-codex"), 2000);
  });

  it("cooldowns gate and prune by time", () => {
    const cooldowns = new Map();

    markCooling(cooldowns, "openai-codex", 5000);
    assert.equal(isCooling(cooldowns, "openai-codex", 4999), true);
    assert.equal(isCooling(cooldowns, "openai-codex", 5000), false);
    assert.equal(isCooling(cooldowns, "openai-codex-account-2", 0), false);
    pruneCooldowns(cooldowns, 5000);
    assert.equal(cooldowns.has("openai-codex"), false);
  });

  it("pruneSessions defaults the idle window and missing lastSeen", () => {
    const sessions = new Map([["x", {}]]);

    pruneSessions(sessions, SESSION_IDLE_MS + 1);

    assert.equal(sessions.has("x"), false);
  });

  it("debug log appends timestamped lines beside the journal", () => {
    const dir = mkdtempSync(join(tmpdir(), "xz-pi-login-debug-"));

    appendDebug(dir, "response", { slot: "a2", action: "record" });

    const lines = readFileSync(join(dir, "xz-pi-login-debug.log"), "utf8").trim().split("\n");

    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).action, "record");
  });

  it("journal appends timestamped JSONL lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "xz-pi-login-journal-"));

    appendJournal(dir, "request", { family: "openai-codex", fp: "ab".repeat(32) });
    appendJournal(dir, "route", { family: "openai-codex", reason: "rotate" });

    const lines = readFileSync(journalPath(dir), "utf8").trim().split("\n");

    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).kind, "request");
    assert.equal(JSON.parse(lines[1]).kind, "route");
    assert.match(lines[0], /"t":"\d{4}-/);
  });

  it("provider exceptions cannot leak credentials into the decision journal or hook error log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rotator-private-errors-"));
    const secret = "fixture-private-credential";
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    let handler;
    const pi = { on(_event, callback) { handler = callback; } };

    try {
      appendJournal(dir, "provider_error", { slot: "fixture-account-2", message: secret });
      safeOn(pi, "fixture-hook", async () => { throw new Error("Authentication failed with " + secret); });
      await handler({}, {});
      appendDebug(dir, "cursor_catalog", { provider: "cursor", outcome: "failed", reason: secret });
      appendJournal(dir, "route", { reason: "rotate", from: "fixture", to: "fixture-account-2" });
      const journal = readFileSync(journalPath(dir), "utf8");
      const debug = readFileSync(join(dir, "xz-pi-login-debug.log"), "utf8");

      assert.doesNotMatch(journal + debug, new RegExp(secret));
      assert.ok(journal.split("\n").filter(Boolean).map(JSON.parse).some(row => row.kind === "provider_error"));
      assert.ok(debug.split("\n").filter(Boolean).map(JSON.parse).some(row => row.kind === "handler_error"));
      assert.ok(journal.split("\n").filter(Boolean).map(JSON.parse).some(row => row.reason === "rotate"), "controlled metadata remains observable");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  it("serialization failures remain cosmetic and cannot break routing", () => {
    const dir = mkdtempSync(join(tmpdir(), "rotator-unserializable-log-"));
    const cyclic = {};
    cyclic.self = cyclic;

    assert.doesNotThrow(() => appendDebug(dir, "fixture", { count: 1n }));
    assert.doesNotThrow(() => appendJournal(dir, "fixture", { cyclic }));
    appendJournal(dir, "route", { reason: "rotate" });
    assert.equal(JSON.parse(readFileSync(journalPath(dir), "utf8")).reason, "rotate", "later valid evidence still persists");
  });

  it("log writes never throw on unwritable dirs", () => {
    const dir = join(tmpdir(), "xz-pi-login-missing-parent", "nope");

    assert.doesNotThrow(() => appendJournal(dir, "request", {}));
    assert.doesNotThrow(() => appendDebug(dir, "x", {}));
  });

  it("pruneSessions drops day-idle session state only", () => {
    const sessions = new Map([
      ["fresh", { lastSeen: 1000 }],
      ["stale", { lastSeen: 0 }],
    ]);

    pruneSessions(sessions, 1000 + SESSION_IDLE_MS, SESSION_IDLE_MS);

    assert.equal(sessions.has("fresh"), true);
    assert.equal(sessions.has("stale"), false);
  });

  it("pins the unavailable statuses recorded for account health", () => {
    assert.deepEqual([...EXHAUSTED_STATUS].sort(), [401, 402, 403, 429]);
  });

  it("classifyResponse records 1xx-3xx statuses as drain", () => {
    assert.equal(classifyResponse(101), "record");
    assert.equal(classifyResponse(200), "record");
    assert.equal(classifyResponse(206), "record");
    assert.equal(classifyResponse(304), "record");
  });

  it("classifyResponse identifies exhausted slots and skips transients", () => {
    assert.equal(classifyResponse(429), "exhausted");
    assert.equal(classifyResponse(402), "exhausted");
    assert.equal(classifyResponse(403), "exhausted");
    assert.equal(classifyResponse(400), "skip");
    assert.equal(classifyResponse(500), "skip");
  });

  it("classifyResponse skips a missing status: no evidence, no drain", () => {
    assert.equal(classifyResponse(undefined), "skip");
    assert.equal(classifyResponse(null), "skip");
    assert.equal(classifyResponse(0), "skip");
    assert.equal(classifyResponse("200"), "skip");
    assert.equal(classifyResponse(200.5), "skip");
  });

  it("needsBackfill fires only for a fingerprinted-but-cold slot", () => {
    const fp = new Map([["a2", { fp: "x", len: 9 }]]);

    assert.equal(needsBackfill({ fingerprints: fp, warm: new Map() }, "a2"), true);
    assert.equal(
      needsBackfill({ fingerprints: fp, warm: new Map([["a2", 1]]) }, "a2"),
      false,
    );
    assert.equal(needsBackfill({ fingerprints: fp, warm: new Map() }, "a3"), false);
    assert.equal(needsBackfill(null, "a2"), false);
  });
});


it("a shorter cooling observation never shortens a live cooldown", () => {
  const cooldowns = new Map();
  markCooling(cooldowns, "slot", 5000);
  markCooling(cooldowns, "slot", 1000);
  assert.equal(isCooling(cooldowns, "slot", 4000), true);
  markCooling(cooldowns, "slot", 8000);
  assert.equal(isCooling(cooldowns, "slot", 7000), true);
});
