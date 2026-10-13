import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const root = dirname(fileURLToPath(new URL("../", import.meta.url)));

test("package contract uses auth-backed physical providers and ships no virtual pool runtime", () => {
  for (const name of ["xz-pi-login", "xz-pi-pmodel", "xz-pi-usage"]) {
    const manifest = JSON.parse(readFileSync(join(root, name, "package.json"), "utf8"));
    assert.match(manifest.peerDependencies["@earendil-works/pi-coding-agent"], /1\.1\.0/);
  }
  for (const path of ["xz-pi-login/lib/pool-registry.ts", "xz-pi-login/lib/pool-router.ts", "xz-pi-login/lib/pool-failover.ts",
    "xz-pi-pmodel/src/pool-bridge.ts", "xz-pi-usage/src/pool-bridge.ts"]) assert.equal(existsSync(join(root, path)), false, path);
  for (const path of ["xz-pi-login/lib/auth-catalog.ts", "xz-pi-login/lib/pool-migration.ts", "xz-pi-login/lib/startup-policy.ts",
    "xz-pi-pmodel/src/auth-providers.ts"]) assert.equal(existsSync(join(root, path)), true, path);
  const runtime = readFileSync(join(root, "xz-pi-login/lib/runtime.ts"), "utf8");
  assert.doesNotMatch(runtime, /registerVirtualModel|createPoolRegistry|failover/);
});
