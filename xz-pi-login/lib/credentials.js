import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

export function readStorage(path) {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Invalid storage object");
  return value;
}

export function effectiveAuth(dir) {
  return readStorage(dir + "/auth.json");
}

export function atomicStorage(path, value) {
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

// Match Pi's FileAuthStorageBackend lock. Read only after locking so token
// refreshes and logins from another process are never overwritten by a snapshot.
export function mutateStoredAuth(path, transform) {
  const release = lockfile.lockSync(path, { realpath: false });
  try {
    const current = readStorage(path);
    const next = transform(current);
    if (JSON.stringify(current) !== JSON.stringify(next)) atomicStorage(path, next);
    return next;
  } finally {
    release();
  }
}
