import type { LayoutPane } from "./herdr.js";

export function choosePlacement(
  callerPaneId: string,
  panes: LayoutPane[],
  childPaneIds: string[],
  mainRatio = 0.72,
  childRatio = 0.5,
): { targetPaneId: string; direction: "right" | "down"; ratio: number } {
  const childIds = new Set(childPaneIds);
  const children = panes
    .filter(pane => childIds.has(pane.pane_id))
    .sort((a, b) => (b.rect.height * b.rect.width) - (a.rect.height * a.rect.width));
  if (!children.length) {
    return { targetPaneId: callerPaneId, direction: "right", ratio: Math.min(0.82, Math.max(0.6, mainRatio)) };
  }
  return { targetPaneId: children[0].pane_id, direction: "down", ratio: Math.min(0.7, Math.max(0.3, childRatio)) };
}
