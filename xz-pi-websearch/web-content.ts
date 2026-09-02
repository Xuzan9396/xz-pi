import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const FETCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
export const INLINE_CHARS = 12_000;

export interface FetchedPage {
  url: string;
  title: string;
  markdown: string;
  contentType: string;
}

function ipv4Number(ip: string): number {
  return ip.split(".").reduce((value, octet) => (value * 256 + Number(octet)) >>> 0, 0);
}

function inV4Range(ip: string, base: string, bits: number): boolean {
  const shift = 32 - bits;
  return (ipv4Number(ip) >>> shift) === (ipv4Number(base) >>> shift);
}

export function isBlockedIp(raw: string): boolean {
  let ip = raw.toLowerCase().split("%")[0] ?? raw.toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (isIP(ip) === 4) {
    return [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
      ["224.0.0.0", 4], ["240.0.0.0", 4],
    ].some(([base, bits]) => inV4Range(ip, base as string, bits as number));
  }
  if (isIP(ip) === 6) {
    return ip === "::" || ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") ||
      /^fe[89ab]/u.test(ip) || ip.startsWith("ff") || ip.startsWith("2001:db8:");
  }
  return true;
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("fetch_content requires an absolute URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP(S) URLs are supported.");
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed.");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("Local and private network URLs are blocked.");
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new Error("Local, private, reserved, and documentation IP ranges are blocked.");
  } else {
    const records = await lookup(host, { all: true, verbatim: true });
    if (!records.length || records.some((record) => isBlockedIp(record.address))) {
      throw new Error("The hostname resolves to a blocked network address.");
    }
  }
  return url;
}

async function boundedBody(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Response exceeds the 5MB limit.");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

export async function safeFetch(raw: string, signal?: AbortSignal, headers: Record<string, string> = {}): Promise<{ response: Response; bytes: Uint8Array }> {
  let url = await assertPublicUrl(raw);
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: combined,
      headers: { "User-Agent": "xz-pi-websearch/0.1", Accept: "text/html,text/plain,application/json,application/markdown,*/*;q=0.5", ...headers },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect ${response.status} has no Location header.`);
      if (redirect === MAX_REDIRECTS) throw new Error("Too many redirects.");
      url = await assertPublicUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) {
      const text = new TextDecoder().decode(await boundedBody(response)).slice(0, 300);
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    return { response, bytes: await boundedBody(response) };
  }
  throw new Error("Too many redirects.");
}

function htmlToMarkdown(html: string, url: string): { title: string; markdown: string } {
  const { document } = parseHTML(html);
  const parsed = new Readability(document as unknown as Document, { charThreshold: 100 }).parse();
  const title = parsed?.title?.trim() || document.title?.trim() || new URL(url).hostname;
  const content = parsed?.content || document.body?.innerHTML || "";
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  turndown.remove(["script", "style", "noscript", "form", "button"]);
  return { title, markdown: turndown.turndown(content).replace(/\n{3,}/gu, "\n\n").trim() };
}

export function decodePage(bytes: Uint8Array, contentType: string, url: string): FetchedPage {
  const text = new TextDecoder("utf-8").decode(bytes);
  if (/text\/html|application\/xhtml\+xml/iu.test(contentType) || /^\s*<!doctype html|^\s*<html/iu.test(text)) {
    const parsed = htmlToMarkdown(text, url);
    return { url, title: parsed.title, markdown: parsed.markdown, contentType };
  }
  if (/application\/json/iu.test(contentType)) {
    let markdown = text;
    try { markdown = `\`\`\`json\n${JSON.stringify(JSON.parse(text), null, 2)}\n\`\`\``; } catch { /* Return malformed JSON as text. */ }
    return { url, title: new URL(url).pathname.split("/").pop() || new URL(url).hostname, markdown, contentType };
  }
  if (/^(text\/|application\/(?:markdown|xml|javascript))/iu.test(contentType) || !contentType) {
    return { url, title: new URL(url).pathname.split("/").pop() || new URL(url).hostname, markdown: text.trim(), contentType };
  }
  throw new Error(`Unsupported content type: ${contentType || "unknown"}.`);
}

export async function fetchPage(raw: string, signal?: AbortSignal): Promise<FetchedPage> {
  const { response, bytes } = await safeFetch(raw, signal);
  return decodePage(bytes, response.headers.get("content-type") ?? "", response.url || raw);
}

export class TempWorkspace {
  readonly root = join(tmpdir(), `xz-pi-websearch-${process.pid}-${Date.now()}`);
  private ready = false;

  async ensure(): Promise<string> {
    if (!this.ready) { await mkdir(this.root, { recursive: true, mode: 0o700 }); this.ready = true; }
    return this.root;
  }

  async savePage(url: string, title: string, markdown: string): Promise<string> {
    const root = await this.ensure();
    const id = createHash("sha256").update(url).digest("hex").slice(0, 16);
    const path = join(root, `page-${id}.md`);
    await writeFile(path, `# ${title}\n\nSource: ${url}\n\n${markdown}\n`, { encoding: "utf8", mode: 0o600 });
    return path;
  }

  async cleanup(): Promise<void> {
    if (this.ready) await rm(this.root, { recursive: true, force: true });
    this.ready = false;
  }
}

export function inlineContent(content: string, path?: string): string {
  if (content.length <= INLINE_CHARS) return content;
  return path
    ? `${content.slice(0, INLINE_CHARS)}\n\n[Content truncated. Full Markdown: ${path}]`
    : `${content.slice(0, INLINE_CHARS)}\n\n[Content truncated at ${INLINE_CHARS.toLocaleString()} characters.]`;
}
