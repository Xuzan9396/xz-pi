import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { CursorShapeController, stripSoftwareCursorWhenHardwareCursorIsUsed } from "../src/cursor-shape.js";

test("cursor controller changes shape and restores terminal state", () => {
  const writes: string[] = [];
  const hardware: boolean[] = [];
  const controller = new CursorShapeController({
    terminal: { write: (data) => writes.push(data) },
    getShowHardwareCursor: () => false,
    setShowHardwareCursor: (value) => hardware.push(value),
  }, true);

  controller.sync("insert");
  controller.sync("insert");
  controller.sync("normal");
  controller.dispose();

  assert.deepEqual(writes, ["\x1b[6 q", "\x1b[2 q", "\x1b[0 q"]);
  assert.deepEqual(hardware, [true, false]);
});

test("cursor controller reasserts visibility and shape after host settings are reapplied", () => {
  const writes: string[] = [];
  const hardware: boolean[] = [];
  const controller = new CursorShapeController({
    terminal: { write: (data) => writes.push(data) },
    getShowHardwareCursor: () => false,
    setShowHardwareCursor: (value) => hardware.push(value),
  }, true);

  controller.sync("insert");
  controller.reassert();
  controller.dispose();
  controller.reassert();

  assert.deepEqual(writes, ["\x1b[6 q", "\x1b[6 q", "\x1b[0 q"]);
  assert.deepEqual(hardware, [true, true, false]);
});

test("hardware cursor mode strips the duplicate software cursor", () => {
  const lines = [`before${CURSOR_MARKER}\x1b[7mX\x1b[0mafter`];
  stripSoftwareCursorWhenHardwareCursorIsUsed(lines);
  assert.equal(lines[0], `before${CURSOR_MARKER}Xafter`);
});

test("quit cleanup explicitly leaves the terminal cursor visible", () => {
  const writes: string[] = [];
  const controller = new CursorShapeController({ terminal: { write: (data) => writes.push(data) } }, true);
  controller.dispose("quit");
  assert.deepEqual(writes, ["\x1b[0 q", "\x1b[?25h"]);
});
