import type { ProviderAuthResult, StoredCredentialReader, UsageContext, UsageSnapshot, UsageStatus } from "./types.js";

export const TIMEOUT_MS = 8_000;
export const MAX_RESPONSE_BYTES = 1_048_576;

export class NotConnectedError extends Error {
  constructor() {
    super("not connected");
    this.name = "NotConnectedError";
  }
}

export class HttpStatusError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code?: string) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.code = code;
  }
}

export function clean(value: unknown, max = 80): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim()
    .slice(0, max);
}

export function clampPercent(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
}

export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return parseTimestamp(numeric);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function readLimitedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("response too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = JSON.parse(await readLimitedText(response)) as Record<string, any>;
    const values = [body.code, body.error?.code, body.error?.type, body.reason];
    const code = values.find((value) => typeof value === "string" && /^[A-Za-z_]{2,40}$/.test(value));
    return typeof code === "string" ? code.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export async function getJson(
  url: string,
  token: string,
  headers: Record<string, string> = {},
  timeoutMs = TIMEOUT_MS,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...headers },
    });
    if (!response.ok) throw new HttpStatusError(response.status, await errorCode(response));
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new Error("response too large");
    }
    try {
      return JSON.parse(await readLimitedText(response));
    } catch (error) {
      if (error instanceof Error && error.message === "response too large") throw error;
      throw new Error("non-JSON response");
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function authError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const failure = new Error(/expired|invalid_grant|revoked|re-?authenticate|refresh/i.test(message) ? "expired" : "auth failed");
  failure.name = "AuthError";
  return failure;
}

async function storedProviderAuth(
  providerId: string,
  readCredential: StoredCredentialReader | undefined,
): Promise<ProviderAuthResult | undefined> {
  if (!readCredential) return undefined;
  const credential = await readCredential(providerId) as Record<string, unknown> | undefined;
  if (credential?.type === "oauth") {
    const access = typeof credential.access === "string" ? credential.access.trim() : "";
    return access ? { source: "OAuth", auth: { apiKey: access } } : undefined;
  }
  if (credential?.type === "api_key") {
    const key = typeof credential.key === "string" ? credential.key.trim() : "";
    return key ? { source: "auth.json", auth: { apiKey: key } } : undefined;
  }
  return undefined;
}

export async function providerAuth(
  ctx: UsageContext,
  providerId: string,
  readCredential?: StoredCredentialReader,
): Promise<ProviderAuthResult | undefined> {
  let resolutionError: unknown;
  try {
    const result = await ctx.modelRegistry.getProviderAuth(providerId);
    if (result) return result;
  } catch (error) {
    resolutionError = error;
  }
  try {
    const stored = await storedProviderAuth(providerId, readCredential);
    if (stored) return stored;
  } catch (error) {
    resolutionError ??= error;
  }
  if (resolutionError) throw authError(resolutionError);
  return undefined;
}

export async function oauthToken(
  ctx: UsageContext,
  providerId: string,
  readCredential?: StoredCredentialReader,
): Promise<string> {
  const result = await providerAuth(ctx, providerId, readCredential);
  if (result?.source !== "OAuth") throw new NotConnectedError();
  const apiKey = result.auth?.apiKey?.trim();
  if (apiKey) return apiKey;
  const headers = result.auth?.headers;
  const authorization = headers instanceof Headers
    ? headers.get("authorization")
    : typeof headers === "object" && headers !== null
      ? Object.entries(headers).find(([name]) => name.toLowerCase() === "authorization")?.[1]
      : undefined;
  const match = typeof authorization === "string" ? authorization.match(/^Bearer\s+(.+)$/i) : null;
  if (!match?.[1]?.trim()) throw new NotConnectedError();
  return match[1].trim();
}

export async function apiKey(
  ctx: UsageContext,
  providerId: string,
  readCredential?: StoredCredentialReader,
): Promise<string> {
  const key = (await providerAuth(ctx, providerId, readCredential))?.auth?.apiKey?.trim();
  if (!key) throw new NotConnectedError();
  return key;
}

export function snapshot(
  providerId: string,
  name: string,
  verified: boolean,
  now: number,
  values: Partial<Omit<UsageSnapshot, "providerId" | "name" | "verified" | "fetchedAt">> = {},
): UsageSnapshot {
  return {
    providerId,
    name,
    verified,
    status: values.status ?? "ok",
    windows: values.windows ?? [],
    credits: values.credits ?? [],
    fetchedAt: now,
    ...(values.plan ? { plan: clean(values.plan, 40) } : {}),
    ...(values.resetCredits ? { resetCredits: values.resetCredits } : {}),
    ...(values.detail ? { detail: clean(values.detail, 80) } : {}),
  };
}

export function errorSnapshot(
  providerId: string,
  name: string,
  verified: boolean,
  now: number,
  error: unknown,
): UsageSnapshot {
  let status: UsageStatus = "error";
  let detail = "查询失败";
  if (error instanceof NotConnectedError) {
    status = "unconnected";
    detail = "未连接";
  } else if (error instanceof Error && error.name === "AuthError") {
    status = error.message === "expired" ? "expired" : "error";
    detail = error.message === "expired" ? "登录过期" : "凭据解析失败";
  } else if (error instanceof HttpStatusError) {
    if (error.status === 401) {
      status = "expired";
      detail = error.code === "token_revoked" ? "登录令牌已撤销，请重新登录" : "登录验证失败，请重新登录";
    } else if (error.status === 403) [status, detail] = ["denied", "无访问权限"];
    else if (error.status === 404 || error.status === 410) [status, detail] = ["endpoint_changed", "接口变化"];
    else if (error.status === 429) [status, detail] = ["rate_limited", "请求过多"];
    else detail = `HTTP ${error.status}`;
  } else if (error instanceof Error && (error.message === "timed out" || error.message === "fetch failed")) {
    status = "network";
    detail = error.message === "timed out" ? "请求超时" : "网络错误";
  } else if (error instanceof Error && (error.message === "response too large" || error.message === "non-JSON response")) {
    [status, detail] = ["endpoint_changed", "响应格式变化"];
  }
  return snapshot(providerId, name, verified, now, { status, detail });
}
