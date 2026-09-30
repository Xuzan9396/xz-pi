import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractAnswer, extractSources } from "./openai-search.ts";
import type { SearchInput, SearchOutput, SearchRoute } from "./search-types.ts";

export const OCI_SEARCH_PROVIDER = "xai-oci";
export const OCI_SEARCH_MODEL = "xai.grok-4.7";
export const OCI_SEARCH_URL = "https://inference.generativeai.us-phoenix-1.oci.oraclecloud.com/20231130/actions/v1/responses";
const KEYCHAIN_SERVICE = "pi-xai-oci-api-key";
const DEFAULT_CREDENTIAL_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;

export const OCI_SEARCH_ROUTE: SearchRoute = {
  provider: OCI_SEARCH_PROVIDER,
  model: OCI_SEARCH_MODEL,
  adapter: "oci-responses",
  flavor: "xai",
  label: `${OCI_SEARCH_PROVIDER} / ${OCI_SEARCH_MODEL}`,
  verified: true,
};

export type OciSecurityRunner = (
  args: readonly string[],
  options: { signal: AbortSignal },
) => Promise<string>;

export interface OciSearchAdapter {
  readonly route: SearchRoute;
  isAvailable(signal?: AbortSignal): Promise<boolean>;
  run(input: SearchInput, signal?: AbortSignal): Promise<SearchOutput>;
  clearSessionCache(): void;
}

type OciEnvironment = { USER?: string; LOGNAME?: string };

interface OciSearchDependencies {
  env?: OciEnvironment;
  runSecurity?: OciSecurityRunner;
  fetchImpl?: typeof fetch;
  credentialTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

interface ParsedOciResponse {
  completed: boolean;
  sawSearch: boolean;
  output: unknown[];
}

const execFileAsync = promisify(execFile);

const defaultSecurityRunner: OciSecurityRunner = async (args, options) => {
  const result = await execFileAsync("security", [...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024,
    signal: options.signal,
  });
  return result.stdout;
};

function abortReason(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException(fallback, "AbortError");
}

function accountName(env: OciEnvironment): string {
  const account = env.USER?.trim() || env.LOGNAME?.trim();
  if (!account) throw new Error("xai-oci credential lookup requires USER or LOGNAME.");
  return account;
}

function keychainArgs(account: string, password: boolean): string[] {
  return ["find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, ...(password ? ["-w"] : [])];
}

function instructions(input: SearchInput): string {
  const count = Math.max(1, Math.min(10, Math.floor(input.numResults ?? 5)));
  const lines = [
    "Search the web and answer only from the search evidence.",
    "Write a concise, well-organized answer with inline clickable citations.",
    `Use at most ${count} strong sources and prefer official or primary sources.`,
    "Do not exceed 800 words.",
  ];
  if (input.recencyFilter) {
    const names = { day: "24 hours", week: "week", month: "month", year: "year" } as const;
    lines.push(`Prefer evidence from the past ${names[input.recencyFilter]}.`);
  }
  return lines.join(" ");
}

function isSearchCall(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "web_search_call";
}

export function parseOciResponse(body: string): ParsedOciResponse {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as { status?: unknown; output?: unknown[] };
    const output = Array.isArray(parsed.output) ? parsed.output : [];
    return { completed: parsed.status === "completed", output, sawSearch: output.some(isSearchCall) };
  }

  const items: unknown[] = [];
  let finalOutput: unknown[] | undefined;
  let sawSearch = false;
  let completed = false;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5).trim();
    if (!value || value === "[DONE]") continue;
    try {
      const event = JSON.parse(value) as Record<string, unknown>;
      if (typeof event.type === "string" && event.type.startsWith("response.web_search_call")) sawSearch = true;
      if (event.type === "response.output_item.done" && event.item) {
        items.push(event.item);
        sawSearch ||= isSearchCall(event.item);
      }
      if (event.type === "response.completed" && event.response && typeof event.response === "object") {
        completed = true;
        const response = event.response as { status?: unknown; output?: unknown[] };
        completed = response.status === undefined || response.status === "completed";
        if (Array.isArray(response.output)) finalOutput = response.output;
      }
    } catch {
      // A malformed event cannot make an otherwise incomplete response successful.
    }
  }
  const output = finalOutput?.length ? finalOutput : items;
  return { completed, output, sawSearch: sawSearch || output.some(isSearchCall) };
}

async function readBounded(response: Response, maxBytes: number, allowTruncate = false): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (!allowTruncate && Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`xai-oci response exceeded ${maxBytes} bytes.`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = maxBytes - total;
    if (value.byteLength > remaining) {
      if (allowTruncate && remaining > 0) chunks.push(value.subarray(0, remaining));
      await reader.cancel().catch(() => {});
      if (!allowTruncate) throw new Error(`xai-oci response exceeded ${maxBytes} bytes.`);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function redact(text: string, credential: string): string {
  return text.replaceAll(credential, "<redacted>").slice(0, 300);
}

export function createOciSearchAdapter(dependencies: OciSearchDependencies = {}): OciSearchAdapter {
  const env = dependencies.env ?? process.env;
  const runSecurity = dependencies.runSecurity ?? defaultSecurityRunner;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const credentialTimeoutMs = dependencies.credentialTimeoutMs ?? DEFAULT_CREDENTIAL_TIMEOUT_MS;
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxResponseBytes = dependencies.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  let cachedCredential: string | undefined;
  let cachedAvailability: boolean | undefined;

  const runCredentialCommand = async (password: boolean, signal?: AbortSignal): Promise<string> => {
    const account = accountName(env);
    const timeout = AbortSignal.timeout(credentialTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await runSecurity(keychainArgs(account, password), { signal: combined });
    } catch {
      if (signal?.aborted) throw abortReason(signal, "xai-oci credential lookup cancelled.");
      if (timeout.aborted) throw new Error(`xai-oci credential lookup timed out after ${credentialTimeoutMs}ms.`);
      throw new Error(`xai-oci credential is unavailable in macOS Keychain service ${KEYCHAIN_SERVICE}.`);
    }
  };

  const isAvailable = async (signal?: AbortSignal): Promise<boolean> => {
    if (cachedCredential) return true;
    if (cachedAvailability !== undefined) return cachedAvailability;
    try {
      accountName(env);
      await runCredentialCommand(false, signal);
      cachedAvailability = true;
    } catch (error) {
      if (signal?.aborted) throw error;
      cachedAvailability = false;
    }
    return cachedAvailability;
  };

  const resolveCredential = async (signal?: AbortSignal): Promise<string> => {
    if (cachedCredential) return cachedCredential;
    const credential = (await runCredentialCommand(true, signal)).trim();
    if (!credential) throw new Error(`xai-oci credential is empty in macOS Keychain service ${KEYCHAIN_SERVICE}.`);
    cachedCredential = credential;
    cachedAvailability = true;
    return credential;
  };

  const run = async (input: SearchInput, signal?: AbortSignal): Promise<SearchOutput> => {
    if (input.domainFilter?.length) throw new Error("xai-oci web search does not support domainFilter.");
    const credential = await resolveCredential(signal);
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetchImpl(OCI_SEARCH_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        signal: combined,
        body: JSON.stringify({
          model: OCI_SEARCH_MODEL,
          instructions: instructions(input),
          input: [{ role: "user", content: [{ type: "input_text", text: input.query }] }],
          tools: [{ type: "web_search" }],
          include: ["web_search_call.action.sources"],
          tool_choice: "required",
          parallel_tool_calls: true,
          store: false,
          stream: true,
        }),
      });
    } catch {
      if (signal?.aborted) throw abortReason(signal, "xai-oci search cancelled.");
      if (timeout.aborted) throw new Error(`xai-oci search timed out after ${requestTimeoutMs}ms.`);
      throw new Error("xai-oci search request failed before receiving a response.");
    }

    if (!response.ok) {
      const error = await readBounded(response, MAX_ERROR_BYTES, true);
      throw new Error(`xai-oci search failed (${response.status}): ${redact(error, credential)}`);
    }

    const parsed = parseOciResponse(await readBounded(response, maxResponseBytes));
    if (!parsed.completed) throw new Error("xai-oci response did not complete.");
    if (!parsed.sawSearch) throw new Error("xai-oci response did not execute web_search.");
    const answer = extractAnswer(parsed.output);
    const sources = extractSources(parsed.output, Math.max(1, Math.min(10, input.numResults ?? 5)));
    if (!answer && !sources.length) throw new Error("xai-oci search returned no answer or sources.");
    return { answer, sources, provider: OCI_SEARCH_PROVIDER, model: OCI_SEARCH_MODEL };
  };

  return {
    route: OCI_SEARCH_ROUTE,
    isAvailable,
    run,
    clearSessionCache() {
      cachedCredential = undefined;
      cachedAvailability = undefined;
    },
  };
}
