import assert from "node:assert/strict";
import test from "node:test";
import { createEditor, send } from "./harness.js";

test("escape enters NORMAL and i returns to INSERT", () => {
  const editor = createEditor("hello");
  assert.equal(editor.getMode(), "normal");
  editor.handleInput("i");
  assert.equal(editor.getMode(), "insert");
});

test("normal motions, delete and count work", () => {
  const editor = createEditor("one two three");
  send(editor, ["w", "2", "x"]);
  assert.equal(editor.getText(), "one o three");
  assert.deepEqual(editor.getRegister(), { text: "tw", kind: "character" });
});

test("operator motion, undo and redo form one change", () => {
  const editor = createEditor("one two");
  send(editor, ["d", "w"]);
  assert.equal(editor.getText(), "two");
  editor.handleInput("u");
  assert.equal(editor.getText(), "one two");
  editor.handleInput("\x12");
  assert.equal(editor.getText(), "two");
});

test("yy and p use the unnamed line register", () => {
  const editor = createEditor("one\ntwo");
  send(editor, ["y", "y", "p"]);
  assert.equal(editor.getText(), "one\none\ntwo");
  assert.equal(editor.getRegister().kind, "line");
});

test("visual delete removes inclusive selection", () => {
  const editor = createEditor("abcd");
  send(editor, ["v", "l", "d"]);
  assert.equal(editor.getText(), "cd");
  assert.equal(editor.getMode(), "normal");
});

test("change command combines deletion and insert session into one undo", () => {
  const editor = createEditor("one two");
  send(editor, ["c", "w", "X", "\x1b"]);
  assert.equal(editor.getText(), "Xtwo");
  editor.handleInput("u");
  assert.equal(editor.getText(), "one two");
});

test("C enters INSERT at the deletion boundary", () => {
  const editor = createEditor("abc");
  send(editor, ["l", "C", "X", "\x1b"]);
  assert.equal(editor.getText(), "aX");
});

test("line deletion removes an orphan final newline", () => {
  const editor = createEditor("one\ntwo");
  send(editor, ["G", "d", "d"]);
  assert.equal(editor.getText(), "one");
});

test("operator composes with gg", () => {
  const editor = createEditor("one\ntwo");
  send(editor, ["G", "d", "g", "g"]);
  assert.equal(editor.getText(), "");
});

test("EX Pi command dispatch preserves draft", () => {
  const editor = createEditor("draft");
  const submitted: string[] = [];
  editor.onSubmit = (text) => submitted.push(text);
  editor.setCommandNamesFn(() => new Set(["tree"]));
  send(editor, [":", "t", "r", "e", "e", "\r"]);
  assert.deepEqual(submitted, ["/tree"]);
  assert.equal(editor.getText(), "draft");
});
