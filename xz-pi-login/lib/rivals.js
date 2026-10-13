// Other account routers may own overlapping Providers or credential resolution.
// Keep standby protection even though xz-pi-login never switches models.
const KNOWN_RIVALS = [
  "pi-rotator",
  "pi-multi-account",
  "@jischeng/pi-multi-account",
  "@henryqw/pi-multi-codex",
  "pi-account-pool",
  "pi-failover",
  "@hu3rror/pi-failover",
  "pi-ccswitch-auto-switch",
  "codex-cliproxy-gateway",
];

function repositoryPath(source) {
  const repository = source.replace(/^git:(?!\/\/)/, "");
  try {
    const path = repository.includes("://") ? new URL(repository).pathname : repository.slice(repository.indexOf("/") + 1);
    return path.split(/[@#]/, 1)[0].replace(/\.git[/\\]*$/, "");
  } catch {
    return "";
  }
}

export function packageNameOf(source) {
  const value = source?.source || source;
  if (!value || value.constructor !== String) return "";
  if (value.startsWith("npm:")) {
    const name = value.slice(4);
    const version = name.indexOf("@", 1);
    return version === -1 ? name : name.slice(0, version);
  }
  const path = /^(git:|https?:\/\/|ssh:\/\/)/i.test(value) ? repositoryPath(value) : value;
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || "";
}

function extensionSources(sources) {
  return (Array.isArray(sources) ? sources : [])
    .filter(source => !Array.isArray(source?.extensions) || source.extensions.length > 0);
}

export function findRivals(sources) {
  const hits = [];
  for (const source of extensionSources(sources)) {
    const name = packageNameOf(source);
    if (KNOWN_RIVALS.includes(name) && !hits.includes(name)) hits.push(name);
  }
  return hits;
}
