import { type Model } from "@earendil-works/pi-ai";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  Input,
  matchesKey,
  parseColor,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  buildProviderGroups,
  type CatalogEntry,
  type CatalogPreferences,
  type ModelReference,
  type ModelScope,
  type ProviderGroup,
} from "./catalog.js";
import type {
  PreferenceLayer,
  PreferenceOverride,
  PreferenceOverrideTarget,
} from "./preferences.js";
import type { ModelDefaultState, ThinkingLevel } from "./pi-settings.js";
import { tokenizeQuery } from "./search.js";
import type { GlobalScopedModelsState } from "./scoped-models.js";

export type SelectorAction =
  | { type: "cancel" }
  | { type: "select-model"; model: Model<any> }
  | { type: "clear-project-model-default" };

export interface PModelSelectorConfig {
  allModels: readonly Model<any>[];
  scopedModels: readonly Model<any>[];
  globalScope: GlobalScopedModelsState;
  preferences: CatalogPreferences;
  current?: ModelReference;
  defaults: ModelDefaultState;
  readThinking: () => ThinkingLevel;
  initialQuery?: string;
  projectTrusted: boolean;
}

export interface PModelSelectorCallbacks {
  onToggleModelDefault: (model: Model<any>, layer: PreferenceLayer) => Promise<ModelDefaultState>;
  onToggleGlobalScope: (model: Model<any>) => GlobalScopedModelsState | Promise<GlobalScopedModelsState>;
  onPreferenceChange: (
    layer: PreferenceLayer,
    override: PreferenceOverride,
  ) => CatalogPreferences | void | Promise<CatalogPreferences | void>;
  onClearProjectPreference: (
    override: PreferenceOverrideTarget,
  ) => CatalogPreferences | void | Promise<CatalogPreferences | void>;
  onError?: (error: unknown) => void;
}

type MainRow =
  | { kind: "provider"; provider: string; group: ProviderGroup }
  | { kind: "model"; provider: string; entry: CatalogEntry };

type ResetItem =
  | { kind: "preference"; label: string; override: PreferenceOverrideTarget }
  | { kind: "model-default"; label: string };

type Submenu = { kind: "reset"; items: ResetItem[]; selected: number };

function sameModel(reference: ModelReference | undefined, entry: Pick<CatalogEntry, "provider" | "id">): boolean {
  return reference?.provider === entry.provider && reference.id === entry.id;
}

function includesTokens(fields: readonly string[], tokens: readonly string[]): boolean {
  const normalized = fields.map((field) => field.toLocaleLowerCase());
  return tokens.every((token) => normalized.some((field) => field.includes(token)));
}

function moveItem<T>(items: readonly T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= items.length) return [...items];
  const result = [...items];
  [result[index], result[target]] = [result[target]!, result[index]!];
  return result;
}

export class PModelSelectorComponent extends Container implements Focusable {
  private readonly searchInput = new Input();
  private readonly list = new Container();
  private readonly scopeText = new Text("", 0, 0);
  private readonly statusText = new Text("", 0, 0);
  private readonly defaultsText = new Text("", 0, 0);
  private readonly thinkingText = new Text("", 0, 0);
  private readonly visibilityText = new Text("", 0, 0);
  private visibilityFocus = false;
  private readonly helpText = new Text("", 0, 0);
  private _focused = false;
  private scope: ModelScope;
  private editLayer: PreferenceLayer;
  private showHidden = false;
  private groups: ProviderGroup[] = [];
  private rows: MainRow[] = [];
  private selectedIndex = 0;
  private collapsed = new Set<string>();
  private preferences: CatalogPreferences;
  private submenu: Submenu | undefined;
  private globalScope: GlobalScopedModelsState;
  private scopeSaving = false;
  private scopeSaved = false;
  private scopeNotice = "";
  private defaults: ModelDefaultState;
  private defaultSaving = false;
  private preferenceSaving = false;
  private defaultNotice = "";
  private column: "model" | PreferenceLayer = "model";
  private searchActive = false;
  private renderWidth = 100;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (action: SelectorAction) => void,
    private readonly config: PModelSelectorConfig,
    private readonly callbacks: PModelSelectorCallbacks,
  ) {
    super();
    this.scope = config.scopedModels.length > 0 ? "scoped" : "all";
    this.editLayer = config.projectTrusted ? "project" : "global";
    this.preferences = config.preferences;
    this.defaults = config.defaults;
    this.searchActive = Boolean(config.initialQuery);
    this.globalScope = config.globalScope;
    for (const model of config.allModels) {
      if (model.provider !== config.current?.provider) this.collapsed.add(model.provider);
    }

    this.addChild(this.scopeText);
    this.addChild(this.thinkingText);
    this.addChild(this.defaultsText);
    this.addChild(this.visibilityText);
    this.addChild(new Spacer(1));
    if (config.initialQuery) this.searchInput.setValue(config.initialQuery);
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.statusText);
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(this.helpText);
    this.searchInput.onSubmit = () => this.activateSelected();
    this.rebuild();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value && this.searchActive;
  }

  private rebuild(): void {
    this.groups = buildProviderGroups(
      this.config.allModels,
      this.config.scopedModels,
      this.scope,
      this.preferences,
      {
        ...(this.config.current ? { current: this.config.current } : {}),
        defaults: this.defaults,
      },
    );
    this.rebuildRows();
  }

  private rebuildRows(): void {
    const query = this.searchInput.getValue();
    const tokens = tokenizeQuery(query);
    const rows: MainRow[] = [];
    let hiddenCurrent = false;
    let hiddenDefault = false;

    for (const group of this.groups) {
      const candidates = this.scope === "all"
        ? group.models.filter((entry) => entry.available)
        : this.showHidden ? group.hiddenModels : group.visibleModels;
      hiddenCurrent ||= group.hiddenModels.some((entry) => sameModel(this.config.current, entry));
      hiddenDefault ||= group.hiddenModels.some((entry) => sameModel(this.defaults.global, entry) || sameModel(this.defaults.project, entry));
      const providerMatches = tokens.length > 0 && includesTokens([group.provider], tokens);
      const matching = tokens.length === 0
        ? candidates
        : candidates.filter((entry) => providerMatches || includesTokens(entry.searchFields, tokens));
      if (matching.length === 0) continue;
      rows.push({ kind: "provider", provider: group.provider, group });
      const expanded = tokens.length > 0 || !this.collapsed.has(group.provider);
      if (expanded) {
        for (const entry of matching) rows.push({ kind: "model", provider: group.provider, entry });
      }
    }

    this.rows = rows;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, rows.length - 1));
    this.scopeText.setText(
      `${this.theme.fg("muted", "Scope: ")}${this.theme.fg("accent", this.scope)}` +
      (this.scope === "all"
        ? this.theme.fg("muted", ` · Sort: global · ✓ = saved global scoped (${this.globalScope.modelIds.length}/${this.config.allModels.length})`)
        : this.theme.fg("muted", " · Sort: global" + (this.showHidden ? " · hidden" : " · visible"))),
    );
    this.visibilityText.setText(this.showHidden && this.scope === "scoped"
      ? (this.visibilityFocus ? this.theme.fg("accent", "→ ") : "  ") + this.theme.fg("muted", "Visibility: ") +
        this.statusBadge(`[${this.editLayer === "global" ? "x" : " "}] global`, "global") + " " +
        this.statusBadge(`[${!this.config.projectTrusted ? "-" : this.editLayer === "project" ? "x" : " "}] project`, "project") +
        this.theme.fg("dim", " · ← global / → project · Space/Enter done · ↑ edit")
      : "");
    const reference = (model: ModelReference | undefined) => model ? `${model.provider}/${model.id}` : "automatic (Pi)";
    this.defaultsText.setText(this.statusBadge(`Global default: ${reference(this.defaults.global)}`, "global") + "\n" +
      this.statusBadge(`Project default: ${this.config.projectTrusted ? this.defaults.project ? reference(this.defaults.project) : "inherits global" : "disabled (untrusted project)"}`, "project"));
    const warnings = [
      this.preferenceSaving ? "Saving preferences…" : "",
      this.defaultSaving ? "Saving model default…" : this.defaultNotice,
      this.scopeSaving ? "Saving global scoped selection…" : this.scopeNotice,
      this.scopeSaved ? "Global scope saved. Restart Pi (pi -c) to sync /model, /scoped-models and cycling; /reload is not enough." : "",
      this.globalScope.projectOverride ? "Project enabledModels overrides global scope; global edits do not clear that override." : "",
      !this.scopeSaved && this.globalScope.sessionDiffers
        ? "Saved global scope differs from this session (project / --models / pending restart)."
        : "",
      this.scope === "all" && this.globalScope.unrestricted ? "Global scope is unrestricted: all available models are checked." : "",
      this.scope === "scoped" && hiddenCurrent ? "current is hidden" : "",
      this.scope === "scoped" && hiddenDefault ? "default is hidden" : "",
    ].filter(Boolean);
    this.statusText.setText(warnings.length > 0 ? this.theme.fg("warning", warnings.join("\n")) : "");
    this.helpText.setText(this.theme.fg(
      "dim",
      this.scope === "all"
        ? "↑↓ move · ←→ fold · Enter check/uncheck scoped (global) · Tab scoped · Esc close"
        : "G=global P=project · ↑↓ move · ←→ model/global/project · Space/Enter check · Enter on name selects · / search · Tab all · Alt+↑/↓ reorder (global) · Ctrl+O hidden · Ctrl+X hide/restore · Ctrl+R reset · Esc close",
    ));
    this.renderList();
    this.tui.requestRender();
  }

  private renderList(): void {
    this.list.clear();
    if (this.submenu) {
      this.renderSubmenu();
      return;
    }
    if (this.rows.length === 0) {
      this.list.addChild(new Text(this.theme.fg("muted", "  No matching models"), 0, 0));
      return;
    }

    const maxVisible = 12;
    let start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.rows.length - maxVisible));
    let continuedProvider: string | undefined;
    const firstRow = this.rows[start];
    if (firstRow?.kind === "model") {
      let providerIndex = start;
      while (providerIndex > 0 && this.rows[providerIndex]?.kind !== "provider") providerIndex -= 1;
      if (this.selectedIndex < providerIndex + maxVisible) start = providerIndex;
      else continuedProvider = firstRow.provider;
    }
    const end = Math.min(start + maxVisible - (continuedProvider ? 1 : 0), this.rows.length);
    if (continuedProvider) {
      this.list.addChild(new Text(this.theme.bold(`▾ ${continuedProvider} (continued)`), 0, 0));
    }
    for (let index = start; index < end; index++) {
      const row = this.rows[index]!;
      const selected = index === this.selectedIndex;
      const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
      if (row.kind === "provider") {
        const folded = this.collapsed.has(row.provider) && this.searchInput.getValue().length === 0;
        const count = this.scope === "all"
          ? row.group.models.filter((entry) => entry.available).length
          : this.showHidden ? row.group.hiddenModels.length : row.group.visibleModels.length;
        const text = `${folded ? "▸" : "▾"} ${row.provider} (${count})`;
        const badges = folded ? [
          this.config.current?.provider === row.provider ? this.statusBadge("current", "current") : "",
          this.defaults.global?.provider === row.provider ? this.statusBadge("global default", "global") : "",
          this.defaults.project?.provider === row.provider ? this.statusBadge("project default", "project") : "",
        ].filter(Boolean) : [];
        this.list.addChild(new Text(
          prefix + (selected ? this.theme.fg("accent", text) : this.theme.bold(text)) +
          (badges.length > 0 ? " " + badges.join(" ") : ""),
          0, 0,
        ));
        continue;
      }

      const entry = row.entry;
      if (this.scope === "scoped") {
        const compact = this.renderWidth < 60;
        const cell = (layer: PreferenceLayer, checked: boolean) => {
          const label = `[${layer === "project" && !this.config.projectTrusted ? "-" : checked ? "x" : " "}] ${compact ? layer === "global" ? "G" : "P" : layer}`;
          const text = selected && this.column === layer ? `‹${label}›` : label;
          return checked ? this.statusBadge(text, layer) : selected && this.column === layer
            ? this.theme.fg("accent", text) : this.theme.fg("muted", text);
        };
        const cells = cell("global", entry.globalDefault) + " " + cell("project", entry.projectDefault);
        const nameWidth = Math.max(1, this.renderWidth - visibleWidth(cells) - 5);
        const plainName = truncateToWidth(entry.id + (entry.available ? "" : " (unavailable)"), nameWidth, "…");
        const name = selected && this.column === "model" ? this.theme.fg("accent", plainName) : plainName;
        const current = entry.current ? this.statusBadge("● ", "current") : "  ";
        this.list.addChild(new Text(`${prefix}${current}${name}${" ".repeat(Math.max(0, nameWidth - visibleWidth(plainName)))} ${cells}`, 0, 0));
        continue;
      }
      const badges = [
        entry.current ? this.statusBadge("current", "current") : "",
        entry.globalDefault ? this.statusBadge("global default", "global") : "",
        entry.projectDefault ? this.statusBadge("project default", "project") : "",
      ].filter(Boolean);
      const details = [
        !entry.available ? "unavailable" : "",
        this.scope === "all" && !entry.visible ? "hidden in scoped picker" : "",
      ].filter(Boolean);
      const markerText = details.length ? this.theme.fg("muted", ` · ${details.join(" · ")}`) : "";
      const check = this.scope === "all"
        ? this.globalScope.modelIds.includes(entry.fullId) ? this.theme.fg("success", "✓ ") : this.theme.fg("muted", "○ ")
        : entry.current ? this.statusBadge("● ", "current") : "  ";
      const name = selected ? this.theme.fg("accent", entry.id) : entry.id;
      // Status comes before potentially long IDs, so truncation cannot hide current/default.
      this.list.addChild(new Text(`${prefix}${check}${badges.length > 0 ? badges.join(" ") + " " : ""}${name}${markerText}`, 0, 0));
    }
    if (start > 0 || end < this.rows.length) {
      this.list.addChild(new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.rows.length})`), 0, 0));
    }
  }

  private statusBadge(label: string, kind: "current" | "project" | "global"): string {
    const colors = this.theme.appearance === "light"
      ? { current: "#0969DA", project: "#825E00", global: "#1A7F37" } as const
      : { current: "#58A6FF", project: "#F2CC60", global: "#7EE787" } as const;
    return this.theme.style(label, { fg: parseColor(colors[kind]), bold: true });
  }

  private renderSubmenu(): void {
    const menu = this.submenu!;

    this.list.addChild(new Text(this.theme.bold("Clear project override"), 0, 0));
    for (const [index, item] of menu.items.entries()) {
      const prefix = index === menu.selected ? this.theme.fg("accent", "→ ") : "  ";
      this.list.addChild(new Text(prefix + item.label, 0, 0));
    }
    this.list.addChild(new Text(this.theme.fg("dim", "Space/Enter clear · Esc back"), 0, 0));
  }

  private selectedRow(): MainRow | undefined {
    return this.rows[this.selectedIndex];
  }

  private activateSelected(): void {
    const row = this.selectedRow();
    if (!row) return;
    if (row.kind === "provider") {
      if (this.collapsed.has(row.provider)) this.collapsed.delete(row.provider);
      else this.collapsed.add(row.provider);
      this.rebuildRows();
      return;
    }
    if (!row.entry.model) return;
    if (this.scope === "all") {
      void this.toggleGlobalScope(row.entry.model);
    } else if (this.column !== "model") {
      void this.toggleDefault(row.entry.model, this.column);
    } else {
      this.done({ type: "select-model", model: row.entry.model });
    }
  }

  private async toggleDefault(model: Model<any>, layer: PreferenceLayer): Promise<void> {
    if (this.defaultSaving) return;
    if (layer === "project" && !this.config.projectTrusted) {
      this.defaultNotice = "Cannot write project defaults before project trust is granted";
      this.rebuildRows();
      return;
    }
    this.defaultSaving = true;
    this.defaultNotice = "";
    this.rebuildRows();
    try {
      this.defaults = await this.callbacks.onToggleModelDefault(model, layer);
    } catch (error) {
      this.defaultNotice = error instanceof Error ? error.message : String(error);
      this.callbacks.onError?.(error);
    } finally {
      this.defaultSaving = false;
      this.rebuild();
    }
  }

  private async toggleGlobalScope(model: Model<any>): Promise<void> {
    if (this.scopeSaving) return;
    this.scopeSaving = true;
    this.scopeNotice = "";
    this.rebuildRows();
    try {
      this.globalScope = await this.callbacks.onToggleGlobalScope(model);
      this.scopeSaved = true;
    } catch (error) {
      this.scopeNotice = error instanceof Error ? error.message : String(error);
      this.callbacks.onError?.(error);
    } finally {
      this.scopeSaving = false;
      this.rebuildRows();
    }
  }

  private applyPreference(override: PreferenceOverride): void {
    const layer = override.field === "visibleModels" ? this.editLayer : "global";
    if (this.preferenceSaving) return;
    this.preferenceSaving = true;
    this.defaultNotice = "";
    this.rebuildRows();
    void Promise.resolve().then(() => this.callbacks.onPreferenceChange(layer, override)).then((preferences) => {
      if (preferences) this.preferences = preferences;
    }).catch((error) => {
      this.defaultNotice = error instanceof Error ? error.message : String(error);
      this.callbacks.onError?.(error);
    }).finally(() => {
      this.preferenceSaving = false;
      this.rebuild();
    });
  }

  private reorder(delta: number): void {
    const row = this.selectedRow();
    if (!row) return;
    if (row.kind === "provider") {
      const providers = this.groups.map((group) => group.provider);
      const index = providers.indexOf(row.provider);
      const next = moveItem(providers, index, delta);
      if (next.join("\0") === providers.join("\0")) return;
      this.selectedIndex = Math.max(0, this.selectedIndex + delta);
      this.applyPreference({ field: "providerOrder", value: next });
      return;
    }
    const group = this.groups.find((item) => item.provider === row.provider);
    if (!group) return;
    const ids = group.models.map((entry) => entry.id);
    const index = ids.indexOf(row.entry.id);
    const next = moveItem(ids, index, delta);
    if (next.join("\0") === ids.join("\0")) return;
    this.selectedIndex = Math.max(0, this.selectedIndex + delta);
    this.applyPreference({ field: "modelOrder", provider: row.provider, value: next });
  }

  private toggleVisibility(): void {
    const row = this.selectedRow();
    if (row?.kind !== "model") return;
    const group = this.groups.find((item) => item.provider === row.provider);
    if (!group) return;
    const visible = new Set(group.visibleModels.filter((entry) => entry.available).map((entry) => entry.id));
    if (row.entry.visible) visible.delete(row.entry.id);
    else if (row.entry.available) visible.add(row.entry.id);
    this.applyPreference({ field: "visibleModels", provider: row.provider, value: [...visible] });
  }

  private openReset(): void {
    if (!this.config.projectTrusted) return;
    const row = this.selectedRow();
    if (!row) return;
    const provider = row.provider;
    const items: ResetItem[] = [
      { kind: "preference", label: `Visible models: ${provider}`, override: { field: "visibleModels", provider } },
      { kind: "model-default", label: "Project model default" },
    ];
    this.submenu = { kind: "reset", items, selected: 0 };
    this.renderList();
    this.tui.requestRender();
  }

  private handleSubmenuInput(data: string): boolean {
    const menu = this.submenu;
    if (!menu) return false;
    const length = menu.items.length;
    if (this.keybindings.matches(data, "tui.select.up")) {
      menu.selected = (menu.selected - 1 + length) % length;
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      menu.selected = (menu.selected + 1) % length;
    } else if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.submenu = undefined;

    } else if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, "space")) {
      const item = menu.items[menu.selected]!;
      if (item.kind === "preference") {
        this.preferenceSaving = true;
        this.defaultNotice = "";
        this.rebuildRows();
        void Promise.resolve().then(() => this.callbacks.onClearProjectPreference(item.override)).then((preferences) => {
          if (preferences) this.preferences = preferences;
          this.submenu = undefined;
        }).catch((error) => {
          this.defaultNotice = error instanceof Error ? error.message : String(error);
          this.callbacks.onError?.(error);
        }).finally(() => {
          this.preferenceSaving = false;
          this.rebuild();
        });
        return true;
      }
      if (item.kind === "model-default") {
        this.done({ type: "clear-project-model-default" });
        return true;
      }
    }
    this.renderList();
    this.tui.requestRender();
    return true;
  }

  handleInput(data: string): void {
    if (this.scopeSaving || this.defaultSaving || this.preferenceSaving) return;
    if (this.handleSubmenuInput(data)) return;
    if (this.visibilityFocus && this.scope === "scoped") {
      if (this.keybindings.matches(data, "tui.editor.cursorLeft")) this.editLayer = "global";
      else if (this.keybindings.matches(data, "tui.editor.cursorRight")) {
        if (this.config.projectTrusted) this.editLayer = "project";
      } else if (matchesKey(data, "space") || this.keybindings.matches(data, "tui.select.confirm") ||
          this.keybindings.matches(data, "tui.select.down")) this.visibilityFocus = false;
      else if (!this.keybindings.matches(data, "tui.select.cancel") && !this.keybindings.matches(data, "app.tools.expand")) return;
      else { this.visibilityFocus = false; }
      if (!this.keybindings.matches(data, "tui.select.cancel") && !this.keybindings.matches(data, "app.tools.expand")) {
        this.rebuildRows();
        return;
      }
    }
    if (matchesKey(data, "space") && !this.searchActive) {
      if (this.scope === "all" || this.column !== "model") this.activateSelected();
      return;
    }
    if (this.scope === "all" && (
      (["app.models.reorderUp", "app.models.reorderDown", "app.tools.expand", "app.thinking.toggle", "app.models.save"] as const)
        .some((action) => this.keybindings.matches(data, action)) ||
      (["ctrl+x", "ctrl+r"] as const).some((key) => matchesKey(data, key))
    )) {
      this.scopeNotice = "all only checks/unchecks global scoped models. Tab to scoped for other actions.";
      this.rebuildRows();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.searchActive = false;
      if (this.showHidden && this.selectedIndex === 0) {
        this.visibilityFocus = true;
        this.rebuildRows();
        return;
      }
      if (this.rows.length > 0) this.selectedIndex = (this.selectedIndex - 1 + this.rows.length) % this.rows.length;
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.searchActive = false;
      if (this.rows.length > 0) this.selectedIndex = (this.selectedIndex + 1) % this.rows.length;
    } else if (this.keybindings.matches(data, "tui.editor.cursorLeft")) {
      const row = this.selectedRow();
      this.searchActive = false;
      if (this.scope === "scoped" && row?.kind === "model") {
        this.column = this.column === "project" ? "global" : "model";
      } else if (row) this.collapsed.add(row.provider);
      this.rebuildRows();
      return;
    } else if (this.keybindings.matches(data, "tui.editor.cursorRight")) {
      const row = this.selectedRow();
      this.searchActive = false;
      if (this.scope === "scoped" && row?.kind === "model") {
        this.column = this.column === "model" ? "global" : "project";
      } else if (row) this.collapsed.delete(row.provider);
      this.rebuildRows();
      return;
    } else if (this.keybindings.matches(data, "tui.input.tab")) {
      this.scope = this.scope === "all" ? "scoped" : "all";
      this.searchActive = false;
      this.column = "model";
      this.visibilityFocus = false;
      this.scopeNotice = "";
      this.rebuild();
      return;
    } else if (this.keybindings.matches(data, "app.models.reorderUp")) {
      this.reorder(-1);
      return;
    } else if (this.keybindings.matches(data, "app.models.reorderDown")) {
      this.reorder(1);
      return;
    } else if (this.keybindings.matches(data, "app.tools.expand")) {
      this.showHidden = !this.showHidden;
      this.visibilityFocus = this.showHidden;
      this.searchActive = false;
      this.selectedIndex = 0;
      this.rebuildRows();
      return;
    } else if (matchesKey(data, "ctrl+x")) {
      this.toggleVisibility();
      return;
    } else if (this.keybindings.matches(data, "app.thinking.toggle") || this.keybindings.matches(data, "app.models.save")) {
      return;
    } else if (matchesKey(data, "ctrl+r")) {
      this.openReset();
      return;
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.activateSelected();
      return;
    } else if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.searchActive) {
        this.searchActive = false;
        this.rebuildRows();
        return;
      }
      this.done({ type: "cancel" });
      return;
    } else {
      if (data === "/" && !this.searchActive) {
        this.searchActive = true;
      } else {
        const before = this.searchInput.getValue();
        this.searchInput.handleInput(data);
        if (before === this.searchInput.getValue() && !this.searchActive) return;
        this.searchActive = true;
      }
      this.column = "model";
      this.searchInput.focused = this._focused;
      this.selectedIndex = 0;
      this.rebuildRows();
      return;
    }
    this.renderList();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    this.renderWidth = width;
    this.thinkingText.setText(this.theme.fg("muted", `Pi thinking: ${this.config.readThinking()} (read-only)`));
    this.searchInput.focused = this._focused && this.searchActive;
    this.renderList();
    return super.render(width).map((line) => truncateToWidth(line, width, ""));
  }

  getRows(): readonly MainRow[] {
    return this.rows;
  }

  getGlobalScopedModelIds(): readonly string[] {
    return this.globalScope.modelIds;
  }

  getScope(): ModelScope {
    return this.scope;
  }

  getEditLayer(): PreferenceLayer {
    return this.editLayer;
  }

  isShowingHidden(): boolean {
    return this.showHidden;
  }
}
