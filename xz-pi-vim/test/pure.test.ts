import assert from "node:assert/strict";
import test from "node:test";
import { parseExCommand } from "../src/ex-command.js";
import { moveByMotion, rangeForMotion } from "../src/motions.js";
import { characterSelectionRange, lineSelectionRange } from "../src/visual-selection.js";

test("word motions cross whitespace and punctuation", () => {
  const text = "one,  two";
  assert.deepEqual(moveByMotion(text, { line: 0, col: 0 }, "w"), { line: 0, col: 3 });
  assert.deepEqual(moveByMotion(text, { line: 0, col: 3 }, "w"), { line: 0, col: 6 });
  assert.deepEqual(moveByMotion(text, { line: 0, col: 6 }, "e"), { line: 0, col: 8 });
  assert.deepEqual(moveByMotion(text, { line: 0, col: 8 }, "b"), { line: 0, col: 6 });
});

test("line motions and operator ranges are bounded", () => {
  const text = "alpha\nbeta\ngamma";
  assert.deepEqual(moveByMotion(text, { line: 0, col: 2 }, "j", 2), { line: 2, col: 2 });
  assert.deepEqual(rangeForMotion(text, { line: 0, col: 0 }, "j"), { start: 0, end: 11, linewise: true });
});

test("visual ranges are inclusive and line mode selects complete lines", () => {
  const text = "abc\ndef";
  assert.deepEqual(characterSelectionRange(text, { line: 0, col: 1 }, { line: 1, col: 1 }), { start: 1, end: 6 });
  assert.deepEqual(lineSelectionRange(text, { line: 0, col: 2 }, { line: 1, col: 0 }), { start: 0, end: 7, linewise: true });
});

test("EX parser separates quit, shell and Pi commands", () => {
  const known = new Set(["tree", "model"]);
  assert.deepEqual(parseExCommand(":q!", known), { kind: "quit", force: true });
  assert.deepEqual(parseExCommand(":!git status", known), { kind: "shell", command: "git status", excludeFromContext: false });
  assert.deepEqual(parseExCommand(":model opus", known), { kind: "pi", name: "model", args: "opus" });
  assert.equal(parseExCommand(":missing", known).kind, "unsupported");
});
