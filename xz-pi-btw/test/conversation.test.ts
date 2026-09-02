import assert from "node:assert/strict";
import test from "node:test";
import {
  appendSideExchange,
  buildSideMessages,
  extractResponseText,
  MAX_SIDE_EXCHANGES,
} from "../src/conversation.js";

test("buildSideMessages keeps main context as reference and appends the current question", () => {
  const messages = buildSideMessages("User: fix auth", [{ question: "why?", answer: "Because." }], "what next?", 1);

  assert.equal(messages.length, 4);
  assert.match((messages[0]!.content[0] as { text: string }).text, /<main-session-reference>/);
  assert.equal((messages.at(-1)!.content[0] as { text: string }).text, "what next?");
});

test("side history is capped at the newest 20 exchanges", () => {
  const exchanges = Array.from({ length: MAX_SIDE_EXCHANGES + 5 }, (_, index) => ({
    question: `q${index}`,
    answer: `a${index}`,
  }));
  const messages = buildSideMessages("main", exchanges, "latest", 1);

  assert.equal(messages.length, 1 + MAX_SIDE_EXCHANGES * 2 + 1);
  assert.equal((messages[1]!.content[0] as { text: string }).text, "q5");
});

test("appendSideExchange and extractResponseText keep concise usable state", () => {
  let exchanges: Array<{ question: string; answer: string }> = [];
  for (let index = 0; index < MAX_SIDE_EXCHANGES + 1; index++) {
    exchanges = appendSideExchange(exchanges, { question: `q${index}`, answer: `a${index}` });
  }

  assert.equal(exchanges.length, MAX_SIDE_EXCHANGES);
  assert.equal(exchanges[0]?.question, "q1");
  assert.equal(
    extractResponseText([
      { type: "thinking", text: "hidden" },
      { type: "text", text: " first " },
      { type: "text", text: "second" },
    ]),
    "first \nsecond",
  );
});
