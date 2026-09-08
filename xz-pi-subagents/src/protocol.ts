import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import type { TaskRecord } from "./types.js";

export const MAX_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_STREAM_BYTES = 32 * 1024 * 1024;
export const cleanText = (text: string): string => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
export const clip = (text: string, max: number): string => text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`;
export function appendTranscript(record: TaskRecord, text: string): void {
  const combined = record.transcript + cleanText(text);
  record.transcript = combined.length > 65_536 ? `[Earlier output omitted; see events.jsonl]\n${combined.slice(-60_000)}` : combined;
}

/** LF-only JSON framing. Handles fragmented UTF-8 and never splits U+2028/U+2029. */
export class JsonLines {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private bytes = 0;
  constructor(private receive: (event: Record<string, unknown>) => void) {}
  push(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > MAX_STREAM_BYTES) throw new Error("Child event stream exceeded 32 MiB");
    this.pending += this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      this.line(line);
    }
    if (Buffer.byteLength(this.pending) > MAX_LINE_BYTES) throw new Error("Child JSON line exceeded 4 MiB");
  }
  end(): void {
    this.pending += this.decoder.end();
    if (this.pending.trim()) this.line(this.pending);
    this.pending = "";
  }
  private line(line: string): void {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("Child JSON line exceeded 4 MiB");
    let event: unknown;
    try { event = JSON.parse(line); } catch { return; } // Some extensions print startup notices.
    if (event && typeof event === "object" && !Array.isArray(event)) this.receive(event as Record<string, unknown>);
  }
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map(part => obj(part).type === "text" ? String(obj(part).text ?? "") : "").join("\n") : "";
}
const finite = (n: unknown): number => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;

export class ChildEvents {
  ready = false;
  started = false;
  ended = false;
  finalSeen = false;
  finalStop = "";
  failure = "";
  private streamed = false;
  private activeTools = new Map<string, string>();
  constructor(private record: TaskRecord, private tools: string[]) {}
  accept(event: Record<string, unknown>): void {
    const record = this.record;
    const message = obj(event.message);
    switch (event.type) {
      case "xz_subagent_ready": {
        const tools = event.tools;
        if (!Array.isArray(tools) || this.tools.some(t => !tools.includes(t))) throw new Error("Child tool receipt does not match requested tools");
        this.ready = true;
        break;
      }
      case "agent_start":
        if (!this.ready) throw new Error("Child policy extension failed to initialize; refusing delegation");
        this.started = true;
        this.ended = false;
        record.activity = "Thinking";
        break;
      case "agent_end": this.ended = true; break;
      case "message_start":
        if (message.role === "assistant") {
          this.streamed = false;
          this.finalSeen = false;
          this.finalStop = "";
          this.failure = "";
          record.output = "";
          appendTranscript(record, "\nAssistant:\n");
        }
        break;
      case "message_update": {
        const delta = obj(event.assistantMessageEvent);
        if (delta.type === "text_delta" && typeof delta.delta === "string") {
          this.streamed = true;
          record.output = clip(record.output + delta.delta, MAX_LINE_BYTES);
          appendTranscript(record, delta.delta);
        }
        break;
      }
      case "message_end":
        if (message.role === "assistant") {
          this.finalSeen = true;
          this.finalStop = String(message.stopReason ?? "");
          this.failure = String(message.errorMessage ?? "");
          record.output = textContent(message.content);
          if (!this.streamed) appendTranscript(record, record.output);
          const usage = obj(message.usage);
          record.tokens += finite(usage.input) + finite(usage.output) + finite(usage.cacheRead) + finite(usage.cacheWrite);
        }
        break;
      case "tool_execution_start": {
        const name = String(event.toolName ?? "tool");
        this.activeTools.set(String(event.toolCallId), name);
        record.activity = [...this.activeTools.values()].join(", ");
        appendTranscript(record, `\n\n→ ${name} ${clip(JSON.stringify(event.args ?? {}), 1200)}\n`);
        break;
      }
      case "tool_execution_end":
        this.activeTools.delete(String(event.toolCallId));
        record.activity = [...this.activeTools.values()].join(", ") || "Thinking";
        appendTranscript(record, `${event.isError ? "ERROR: " : ""}${clip(textContent(obj(event.result).content), 4000)}\n`);
        break;
      case "auto_retry_start": record.activity = "Retrying"; break;
      case "compaction_start": record.activity = "Compacting"; break;
    }
  }
  completionError(): string | undefined {
    if (!this.ready || !this.started || !this.ended || !this.finalSeen) return "Child exited without a complete run/response";
    if (this.finalStop !== "stop") return this.failure || `Child stopped with ${this.finalStop || "unknown reason"}; partial output retained`;
    if (!this.record.output.trim()) return "Child returned no final text";
    return undefined;
  }
}
