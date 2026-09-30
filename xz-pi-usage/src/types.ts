export type UsageStatus =
  | "ok"
  | "unconnected"
  | "expired"
  | "denied"
  | "rate_limited"
  | "endpoint_changed"
  | "network"
  | "unsupported"
  | "error";

export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetAt?: number;
  windowMs?: number;
}

export interface UsageCredits {
  label: string;
  used: number;
  limit?: number;
  resetAt?: number;
}

export interface UsageResetCredits {
  available: number;
  expiresAt: number[];
}

export interface UsageSnapshot {
  providerId: string;
  name: string;
  plan?: string;
  status: UsageStatus;
  verified: boolean;
  windows: UsageWindow[];
  credits: UsageCredits[];
  resetCredits?: UsageResetCredits;
  fetchedAt: number;
  detail?: string;
}

export interface ProviderAuthResult {
  source?: string;
  auth?: {
    apiKey?: string | undefined;
    headers?: unknown;
  };
}

export interface UsageContext {
  modelRegistry: {
    getProviderAuth(provider: string): Promise<ProviderAuthResult | undefined>;
  };
}

export type StoredCredentialReader = (providerId: string) => unknown | Promise<unknown>;

export interface ProviderDeps {
  readCredential?: StoredCredentialReader;
  now?: () => number;
}

export interface ProviderAdapter {
  id: string;
  name: string;
  verified: boolean;
  matches(providerId: string): boolean;
  fetch(ctx: UsageContext, providerId: string, deps?: ProviderDeps): Promise<UsageSnapshot>;
}
