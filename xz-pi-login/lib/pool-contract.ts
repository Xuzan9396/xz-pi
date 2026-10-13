// Compatibility helpers for settings written by xz-pi-login before 10.1.
// New selections always use physical Provider IDs from auth.json.
export const POOL_PREFIX = "xz-login-";

export function isRecord(value) {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
export function safeIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value) &&
    !["__proto__", "constructor", "prototype"].includes(value);
}
export function providerIdentity(value) {
  return safeIdentity(value) && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
}
export function onlyKeys(value, keys) {
  return isRecord(value) && Object.keys(value).every(key => keys.includes(key));
}
export function poolBase(provider) {
  if (typeof provider !== "string" || !provider.startsWith(POOL_PREFIX)) return undefined;
  const base = provider.slice(POOL_PREFIX.length);
  return providerIdentity(base) && !base.startsWith(POOL_PREFIX) ? base : undefined;
}
export const legacyPoolBase = poolBase;
