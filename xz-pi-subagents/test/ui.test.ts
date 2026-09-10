import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomEditor, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { XzModalEditor } from "../../xz-pi-vim/src/modal-editor.js";
import { TaskManager } from "../src/manager.js";
import { canEnterFleet, DetailView, FleetView } from "../src/ui.js";
import { deferred, plan, record, tick } from "./helpers.js";
import type { RunOutcome } from "../src/types.js";

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, borderColor: (text: string) => text, selectList: {} } as unknown as Theme;
const keybindings = { matches: () => false } as unknown as ConstructorParameters<typeof CustomEditor>[2];
function harness(vim = false) {
  let focused: Component | null = null;
  let detail: Component | undefined;
  let widget: Component | undefined;
  let handler: ((data: string) => unknown) | undefined;
  let overlay = false;
  const tui = {
    children: [] as Component[], hasOverlay: () => overlay, getFocusedComponent: () => focused,
    requestRender() {}, terminal: { rows: 32, columns: 90, write() {} }, getShowHardwareCursor: () => false,
  } as unknown as TUI;
  const editorTheme = theme as unknown as ConstructorParameters<typeof CustomEditor>[1];
  const editor = vim ? new XzModalEditor(tui, editorTheme, keybindings) : new CustomEditor(tui, editorTheme, keybindings);
  editor.focused = true; focused = editor; tui.children.push(editor);
  const ctx = { mode: "tui", ui: {
    onTerminalInput: (fn: typeof handler) => { handler = fn; return () => { handler = undefined; }; },
    setWidget: (_key: string, factory: ((t: TUI, th: Theme) => Component) | undefined) => { widget = factory?.(tui, theme); },
    notify() {},
    custom: (factory: (t: TUI, th: Theme, kb: unknown, done: () => void) => Component) => new Promise<void>(resolve => {
      overlay = true; editor.focused = false;
      detail = factory(tui, theme, keybindings, () => { overlay = false; detail = undefined; editor.focused = true; focused = editor; resolve(); });
      focused = detail;
    }),
  } } as unknown as ExtensionContext;
  const manager = new TaskManager(); manager.records = [record("first"), record("second")];
  const fleet = new FleetView(manager); fleet.attach(ctx);
  return { fleet, manager, editor, tui, input: (data: string) => handler?.(data), detail: () => detail, widget: () => widget, focus: (component: Component | null) => { focused = component; } };
}

test("empty input enters fleet, arrows select, Enter opens live detail, Esc only returns", async () => {
  const h = harness();
  assert.deepEqual(h.input("\x1b[B"), { consume: true });
  h.input("\x1b[B"); h.input("\r");
  assert.ok(h.detail());
  h.manager.records[0]!.transcript = "live output now";
  assert.match(h.detail()!.render(80).join("\n"), /live output now/);
  h.detail()!.handleInput?.("\x1b"); await tick();
  assert.equal(h.detail(), undefined); assert.equal(h.manager.records[0]?.status, "running");
  h.input("\x1b"); assert.equal(h.widget(), undefined); assert.equal(h.input("x"), undefined);
  h.fleet.dispose(); assert.equal(h.widget(), undefined);
});

test("two-press cancellation targets only the selected task and selection changes disarm", () => {
  const h = harness();
  h.input("\x1b[B"); h.input("\x1b[B"); h.input("x");
  assert.equal(h.manager.records[0]?.status, "running");
  h.input("\x1b[B"); h.input("x"); assert.equal(h.manager.records[1]?.status, "running");
  h.input("x"); assert.equal(h.manager.records[1]?.status, "stopping");
  assert.equal(h.manager.records[0]?.status, "running"); h.fleet.dispose();
});

test("normal text, completion menus, dialogs and key releases are not hijacked", () => {
  const h = harness();
  h.editor.setText("draft"); assert.equal(h.input("\x1b[B"), undefined);
  h.editor.setText(""); Reflect.set(h.editor, "autocompleteState", "prefix");
  assert.equal(h.input("\x1b[B"), undefined); Reflect.set(h.editor, "autocompleteState", null);
  h.focus({ render: () => [], invalidate() {} }); assert.equal(h.input("\x1b[B"), undefined);
  h.focus(h.editor); assert.equal(h.input("\x1b[1;1:3B"), undefined);
  h.input("\x1b[B"); assert.equal(h.input("a"), undefined);
  h.fleet.dispose();
});

test("xz-pi-vim is not replaced and keeps h/j/k/l, insert editing and ex-mode keys", () => {
  const h = harness(true);
  const editor = h.editor as XzModalEditor;
  assert.ok(canEnterFleet(h.tui)); assert.equal(h.input("j"), undefined);
  editor.handleInput("\x1b"); assert.equal(editor.getMode(), "normal");
  assert.ok(canEnterFleet(h.tui));
  assert.deepEqual(h.input("\x1b[B"), { consume: true }); h.input("\x1b");
  editor.handleInput(":"); assert.equal(editor.getMode(), "ex"); assert.equal(h.input("\x1b[B"), undefined);
  h.fleet.dispose();
});

test("narrow/Unicode renders remain bounded; finished tasks remain inspectable", () => {
  const h = harness();
  h.manager.records[0]!.task = "中文任务🙂".repeat(80);
  h.manager.records[0]!.status = "completed"; h.manager.changed();
  for (const width of [0, 1, 8, 24, 80]) {
    for (const line of h.fleet.render(width, theme)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
  }
  h.input("\x1b[B"); h.input("\x1b[B"); h.input("\r"); assert.ok(h.detail());
  for (const line of h.detail()!.render(24)) assert.ok(visibleWidth(line) <= 24);
  h.fleet.dispose();
});

test("hiding keeps work/records/files, survives late updates, reopens, and a new batch auto-shows", async t => {
  const h = harness(); t.after(() => h.fleet.dispose());
  const dir = await mkdtemp(join(tmpdir(), "xz-panel-test-")); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "output.md"), "saved result");
  await writeFile(join(dir, "events.jsonl"), "saved events");
  const gate = deferred<RunOutcome>(); let childSignal: AbortSignal | undefined;
  const batch = h.manager.run([plan("live", "write")], 1, (_p, r, signal) => {
    r.artifactDir = dir; childSignal = signal; return gate.promise;
  });
  await tick(); const records = h.manager.records;
  h.input("\x1b[B"); h.input("\x1b");
  assert.equal(h.widget(), undefined); assert.equal(childSignal?.aborted, false);
  assert.equal(h.manager.records, records); assert.equal(h.manager.records[0]?.status, "running");
  h.manager.changed(); assert.equal(h.widget(), undefined);
  assert.equal(h.fleet.show(), true); assert.ok(h.widget());
  h.input("\x1b[B"); h.input("\x1b"); assert.equal(h.widget(), undefined);
  gate.resolve({ status: "completed", output: "done" }); await batch;
  assert.equal(h.widget(), undefined);
  assert.equal(await readFile(join(dir, "output.md"), "utf8"), "saved result");
  assert.equal(await readFile(join(dir, "events.jsonl"), "utf8"), "saved events");
  h.input("\x1b[B"); assert.ok(h.widget()); h.input("\x1b");
  assert.equal(h.widget(), undefined);
  await h.manager.run([plan("next")], 1, async () => ({ status: "completed", output: "next result" }));
  assert.ok(h.widget()); assert.match(h.widget()!.render(100).join("\n"), /next/);
});

test("whole-batch abort hides only after cleanup, and reopening is not undone by updates", async t => {
  const h = harness(); t.after(() => h.fleet.dispose());
  const gate = deferred<RunOutcome>(); const abort = new AbortController();
  const batch = h.manager.run([plan("live")], 1, () => gate.promise, abort.signal);
  await tick(); abort.abort();
  assert.equal(h.manager.records[0]?.status, "stopping"); assert.ok(h.widget());
  gate.resolve({ status: "cancelled", output: "partial" }); await batch;
  assert.equal(h.widget(), undefined); assert.equal(h.manager.records[0]?.output, "partial");
  h.manager.changed(); assert.equal(h.widget(), undefined);
  h.input("\x1b[B"); assert.ok(h.widget()); h.manager.changed(); assert.ok(h.widget());
});

test("batch cancellation does not dismiss an open detail or conceal cleanup failure", async t => {
  const h = harness(); t.after(() => h.fleet.dispose());
  const gate = deferred<RunOutcome>();
  const batch = h.manager.run([plan("reading")], 1, () => gate.promise);
  await tick(); h.input("\x1b[B"); h.input("\x1b[B"); h.input("\r");
  const viewer = h.detail(); assert.ok(viewer);
  h.manager.cancelAll(); gate.resolve({ status: "cancelled", output: "partial" }); await batch;
  assert.equal(h.detail(), viewer); assert.ok(h.widget());
  viewer.handleInput?.("\x1b"); await tick(); assert.ok(h.widget());
  h.input("\x1b"); assert.equal(h.widget(), undefined);
  const failed = deferred<RunOutcome>();
  const second = h.manager.run([plan("cleanup-failure")], 1, () => failed.promise);
  await tick(); h.manager.cancelAll();
  failed.resolve({ status: "failed", output: "", error: "Process cleanup could not be verified" }); await second;
  assert.ok(h.widget()); assert.equal(h.manager.records[0]?.status, "failed");
});

test("detail cancel confirmation, scrolling and terminal text sanitization", () => {
  const r = record(); r.transcript = "\x1b[2Jbad\x07\n" + "row\n".repeat(100);
  let cancels = 0, closes = 0, continues = 0;
  const detail = new DetailView(r, theme, () => 30, () => {}, () => { closes++; }, () => { cancels++; }, () => { continues++; return true; });
  assert.ok(detail.render(40).length <= 24);
  detail.handleInput("x"); detail.handleInput("\x1b[A"); detail.handleInput("x"); assert.equal(cancels, 0);
  detail.handleInput("x"); assert.equal(cancels, 1);
  r.status = "paused"; detail.handleInput("c"); assert.equal(continues, 1);
  assert.match(detail.render(60).join("\n"), /c 启动全新 Agent 继续/);
  detail.handleInput("\x1b"); assert.equal(closes, 1);
});
