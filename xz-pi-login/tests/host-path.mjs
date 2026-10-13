import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

function isModernHost(entry) {
  let dir = dirname(entry);
  while (true) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.name === "@earendil-works/pi-coding-agent") {
        const [major, minor] = pkg.version.split(".").map(Number);
        return major > 1 || (major === 1 && minor >= 1);
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function findHost() {
  const explicit = process.env.XZ_PI_LOGIN_TEST_HOST;
  const candidates = explicit ? [explicit] : (process.env.PATH || "").split(delimiter).map(dir => join(dir, "pi"));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const entry = realpathSync(candidate);
    if (isModernHost(entry)) return entry;
  }
  throw new Error("xz-pi-login tests require Pi 1.1+. Set XZ_PI_LOGIN_TEST_HOST to that Pi CLI entry; older workspace binaries are not supported.");
}

// npm prepends workspace .bin directories to PATH. Do not accidentally select
// an older SDK there instead of the modern Pi that loads the real extension.
export const hostEntry = findHost();
