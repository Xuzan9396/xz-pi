import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { colorContextUsage, colorModelForThinking, formatFooterLocation, layoutFooterHeader } from "../src/footer.js";

const header = {
  pwd: "~/go/src/myai/xz-pi (main)",
  context: "31.0%/400k (auto)",
  provider: "openai-codex-xuzan",
  model: "gpt-5.6-sol • medium",
};

test("compact footer puts path, context, provider, and model on one line", () => {
  const line = layoutFooterHeader(header, 120);
  assert.match(line, /^~\/go\/src\/myai\/xz-pi \(main\)  31\.0%\/400k \(auto\)/);
  assert.match(line, /\(openai-codex-xuzan\) gpt-5\.6-sol • medium$/);
  assert.doesNotMatch(line, /↑|↓|CH|\$[0-9]/);
});

test("compact footer colors only the git branch with the success theme", () => {
  const location = formatFooterLocation(
    "/workspace/xz-pi",
    "main_yehuo_game",
    "session",
    (branch) => `<success>${branch}</success>`,
  );
  assert.equal(location, "/workspace/xz-pi (<success>main_yehuo_game</success>) • session");
});

test("compact footer applies the requested style only to provider and model metadata", () => {
  const line = layoutFooterHeader(header, 120, (text) => `<thinking>${text}</thinking>`);
  assert.match(line, /31\.0%\/400k \(auto\)\s+<thinking>\(openai-codex-xuzan\) gpt-5\.6-sol • medium<\/thinking>$/);
  assert.doesNotMatch(line, /<thinking>~\/go/);
});

test("context usage uses the bright border accent theme color", () => {
  const colors: string[] = [];
  const theme = {
    fg: (color: string, text: string) => {
      colors.push(color);
      return `<${color}>${text}</${color}>`;
    },
  };
  assert.equal(colorContextUsage(theme as never, "29.1%/400k (auto)"), "<borderAccent>29.1%/400k (auto)</borderAccent>");
  assert.deepEqual(colors, ["borderAccent"]);
});

test("model metadata uses the active thinking-level border color", () => {
  const levels: string[] = [];
  const theme = {
    getThinkingBorderColor: (level: string) => {
      levels.push(level);
      return (text: string) => `<${level}>${text}</${level}>`;
    },
  };
  assert.equal(colorModelForThinking(theme as never, "medium", "model"), "<medium>model</medium>");
  assert.equal(colorModelForThinking(theme as never, undefined, "model"), "<off>model</off>");
  assert.deepEqual(levels, ["medium", "off"]);
});

test("compact footer hides the provider first and preserves model metadata", () => {
  const line = layoutFooterHeader(header, 75);
  assert.doesNotMatch(line, /openai-codex-xuzan/);
  assert.ok(line.endsWith("gpt-5.6-sol • medium"));
  assert.ok(visibleWidth(line) <= 75);
});
