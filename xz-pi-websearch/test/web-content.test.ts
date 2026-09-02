import test from "node:test";
import assert from "node:assert/strict";
import { decodePage, inlineContent, isBlockedIp } from "../web-content.ts";

test("blocks private and reserved addresses", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.1.1", "192.168.1.1", "169.254.1.1", "::1", "fd00::1"]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  assert.equal(isBlockedIp("8.8.8.8"), false);
  assert.equal(isBlockedIp("2606:4700:4700::1111"), false);
});

test("extracts readable HTML as markdown", () => {
  const html = `<!doctype html><html><head><title>Example</title></head><body><main><article><h1>Guide</h1><p>This is useful documentation with enough readable words for extraction.</p><script>bad()</script></article></main></body></html>`;
  const page = decodePage(new TextEncoder().encode(html), "text/html; charset=utf-8", "https://example.com/guide");
  assert.equal(page.title.includes("Example") || page.title.includes("Guide"), true);
  assert.match(page.markdown, /Guide/);
  assert.doesNotMatch(page.markdown, /bad\(\)/);
});

test("formats JSON and truncates long inline content", () => {
  const page = decodePage(new TextEncoder().encode('{"ok":true}'), "application/json", "https://example.com/data.json");
  assert.match(page.markdown, /"ok": true/);
  assert.match(inlineContent("x".repeat(13_000), "/tmp/full.md"), /Content truncated/);
});
