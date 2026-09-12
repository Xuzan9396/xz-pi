export interface CurrentPlan {
  version: string;
  requirement: string;
}

const VERSION_PATTERN = /^\d+(?:\.\d+)*$/;

/** Parse the latest valid row from the "当前进度" Markdown table. */
export function parseLatestCurrentPlan(markdown: string): CurrentPlan | null {
  const lines = markdown.split(/\r?\n/);
  const sectionStart = lines.findIndex((line) => /^##\s+当前进度\s*$/.test(line.trim()));
  if (sectionStart < 0) return null;

  const section: string[] = [];
  for (let index = sectionStart + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) break;
    if (/^##\s+/.test(line.trim())) break;
    section.push(line);
  }

  const headerIndex = section.findIndex((line) => {
    const cells = splitTableRow(line);
    return cells?.includes("版本") === true && cells.includes("需求");
  });
  if (headerIndex < 0) return null;

  const header = splitTableRow(section[headerIndex] ?? "");
  if (!header) return null;
  const versionIndex = header.indexOf("版本");
  const requirementIndex = header.indexOf("需求");
  if (versionIndex < 0 || requirementIndex < 0) return null;

  let latest: CurrentPlan | null = null;
  for (const line of section.slice(headerIndex + 1)) {
    const cells = splitTableRow(line);
    if (!cells || isSeparatorRow(cells)) continue;
    const version = cells[versionIndex]?.trim() ?? "";
    const requirement = cells[requirementIndex]?.trim() ?? "";
    if (!VERSION_PATTERN.test(version) || requirement.length === 0) continue;

    const candidate = { version, requirement };
    if (!latest || compareVersions(candidate.version, latest.version) >= 0) latest = candidate;
  }

  return latest;
}

export function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;

  const cells: string[] = [];
  let cell = "";
  for (let index = 1; index < trimmed.length - 1; index++) {
    const character = trimmed[index];
    if (character === "\\" && trimmed[index + 1] === "|") {
      cell += "|";
      index++;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}
