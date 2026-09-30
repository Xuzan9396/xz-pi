import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import { cloneSearchPreference, type SearchPreference, type SearchRoute } from "./search-types.ts";

export const AUTOMATIC_ROUTE_LABEL = "Automatic (allow cross-provider fallback)";
export const CURRENT_PROVIDER_LABEL = "Current model/provider (same-provider fallback)";

export interface SearchSelection {
  preference: SearchPreference;
  saveDefault: boolean;
}

export interface SearchSelectorItem extends SelectItem {
  preference: SearchPreference;
}

function preferenceKey(preference: SearchPreference): string {
  return preference.mode === "fixed"
    ? `fixed\0${preference.provider}\0${preference.model}`
    : preference.mode;
}

function samePreference(a: SearchPreference, b: SearchPreference): boolean {
  return preferenceKey(a) === preferenceKey(b);
}

export function formatPreferenceMarkers(
  preference: SearchPreference,
  current: SearchPreference,
  savedDefault: SearchPreference,
): string {
  const markers = [
    ...(samePreference(preference, current) ? ["current"] : []),
    ...(samePreference(preference, savedDefault) ? ["default"] : []),
  ];
  return markers.length ? ` (${markers.join(", ")})` : "";
}

export function buildSearchSelectorItems(
  routes: readonly SearchRoute[],
  current: SearchPreference,
  savedDefault: SearchPreference,
): SearchSelectorItem[] {
  const values: Array<{ label: string; preference: SearchPreference }> = [
    { label: AUTOMATIC_ROUTE_LABEL, preference: { mode: "auto" } },
    { label: CURRENT_PROVIDER_LABEL, preference: { mode: "current-provider" } },
    ...routes.map((route) => ({
      label: route.label,
      preference: { mode: "fixed", provider: route.provider, model: route.model } as SearchPreference,
    })),
  ];

  return values.map((value) => ({
    value: preferenceKey(value.preference),
    label: `${value.label}${formatPreferenceMarkers(value.preference, current, savedDefault)}`,
    preference: cloneSearchPreference(value.preference),
  }));
}

function selectionForItem(items: readonly SearchSelectorItem[], item: SelectItem | null, saveDefault: boolean): SearchSelection | undefined {
  if (!item) return undefined;
  const selected = items.find((candidate) => candidate.value === item.value);
  return selected ? { preference: cloneSearchPreference(selected.preference), saveDefault } : undefined;
}

export async function showTuiSearchSelector(
  ctx: Pick<ExtensionContext, "ui">,
  routes: readonly SearchRoute[],
  current: SearchPreference,
  savedDefault: SearchPreference,
): Promise<SearchSelection | undefined> {
  const items = buildSearchSelectorItems(routes, current, savedDefault);
  return ctx.ui.custom<SearchSelection | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold("Select Web Search Route"))));
    const selectList = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    const selectedIndex = items.findIndex((item) => samePreference(item.preference, current));
    if (selectedIndex >= 0) selectList.setSelectedIndex(selectedIndex);
    selectList.onSelect = (item) => done(selectionForItem(items, item, false));
    selectList.onCancel = () => done(undefined);
    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter use in session • ctrl+s save default • esc cancel")));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.ctrl("s"))) {
          done(selectionForItem(items, selectList.getSelectedItem(), true));
          return;
        }
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

export async function showRpcSearchSelector(
  ctx: Pick<ExtensionContext, "ui">,
  routes: readonly SearchRoute[],
  current: SearchPreference,
  savedDefault: SearchPreference,
): Promise<SearchSelection | undefined> {
  const items = buildSearchSelectorItems(routes, current, savedDefault);
  const selectedLabel = await ctx.ui.select("Select web search route", items.map((item) => item.label));
  if (!selectedLabel) return undefined;
  const selected = items.find((item) => item.label === selectedLabel);
  if (!selected) return undefined;
  const saveDefault = await ctx.ui.confirm("Save default search route", "Use this route as the default for new sessions?");
  return { preference: cloneSearchPreference(selected.preference), saveDefault };
}

export async function showSearchSelector(
  ctx: Pick<ExtensionContext, "ui" | "mode" | "hasUI">,
  routes: readonly SearchRoute[],
  current: SearchPreference,
  savedDefault: SearchPreference,
): Promise<SearchSelection | undefined> {
  if (!ctx.hasUI) return undefined;
  return ctx.mode === "tui"
    ? showTuiSearchSelector(ctx, routes, current, savedDefault)
    : showRpcSearchSelector(ctx, routes, current, savedDefault);
}
