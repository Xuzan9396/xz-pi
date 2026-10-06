# xz-pi-pmodel

A provider-grouped model picker with direct global/project default checkboxes for Pi. Thinking is read-only and always comes from Pi's actual session state.

The package adds `/pmodel` without replacing `/model`, `/scoped-models`, or `/thinking`.

## Requirements

- Node.js 22.19 or newer
- Pi 1.0 or newer

## Install

```bash
pi install npm:xz-pi-pmodel
```

For local development:

```bash
pi install /Users/admin/go/src/myai/xz-pi/xz-pi-pmodel
```

Run `/reload` after changing extension source.

## Command and layout

```text
/pmodel
/pmodel <initial search>

Scope: scoped · Sort: global
Pi thinking: high (read-only)
Global default: provider/model-a
Project default: provider/model-b

▾ provider
  ● model-b                      [ ] global [x] project
    model-a                      [x] global [ ] project
```

`●` is the current model. Global defaults are green, project defaults yellow, and the current marker blue, with dark/light theme contrast. Both saved defaults remain visible even when a project overrides global, a provider is folded, or a default is hidden/outside the active scope. Narrow rows use `G` and `P` and reserve space for the checkboxes before truncating model names. `‹…›` identifies the focused checkbox.

### Default checkboxes

Only **scoped** allows default changes. Use left/right on a model row to focus its name, global checkbox, or project checkbox. Space and Enter activate the focused checkbox.

- Each column has at most one selected default; choosing another model replaces only that column's selection.
- A saved global default cannot be unchecked, matching the built-in `/model` save behavior. An unset global default is shown as automatic rather than inventing a default.
- A project default can be unchecked; it then inherits global. Inherited defaults do not appear as checked project overrides.
- Project editing is disabled until project trust is granted.
- Saving a default does **not** switch the current model. Enter on the model name switches it through Pi's public API.
- Writes are serialized. Checks update only after persistence succeeds; failures retain the old state and show the error. The picker stays open and reloads official default caches once after closing when necessary.

Defaults use Pi's own `defaultProvider` and `defaultModel` fields. Global writes use `SettingsManager`; project writes preserve unrelated JSON fields. Native startup priorities, CLI overrides and session restore are not overridden.

### Thinking: Pi owns the setting

The header reads `pi.getThinkingLevel()` and displays the actual current thinking level. Change thinking with Pi's built-in `/thinking` or native controls, then reopen `/pmodel` to see it. There are no per-row predictions, thinking menus, or thinking setters in this package. Model switches may change thinking according to Pi's own behavior, not an extension policy.

### Keys

| Key | Action |
| --- | --- |
| `↑/↓` | Navigate provider/model rows; up from the first hidden row returns to visibility scope |
| `←/→` | Fold/unfold provider rows; focus name/global/project on model rows |
| `Space/Enter` | Activate a default checkbox; in `all`, check/uncheck scoped membership |
| `Enter` on a model name | Switch the current model in `scoped` |
| Printable input or `/` | Focus search; spaces in search separate keywords |
| `Tab` | Toggle `all/scoped` |
| `Alt+↑/↓` | Reorder provider/models globally in `scoped` |
| `Ctrl+O` | Show hidden management and its explicit global/project scope selector |
| `Ctrl+X` | Hide/restore the model using the selected visibility scope |
| `Ctrl+R` | Clear project visibility/model overrides; no thinking options |
| `Esc` | Leave search/submenu, or close the picker |

There is no layer-switch shortcut or thinking-settings shortcut. Sorting never depends on visibility scope or default columns.

Search is case-insensitive, whitespace-tokenized, contiguous-substring AND matching across provider, model ID, `provider/id`, model name, `current`, and either `default`. While search has focus, Space is input, not a checkbox action; arrow navigation returns to the list.

## All/scoped and official synchronization

`all` is a **global scoped-membership checklist only**. It includes all authenticated models, including extension-hidden models. It cannot modify defaults, visibility, ordering, or thinking. Its checkmark means saved global `enabledModels` membership, not the current model or a default.

`scoped` continues to use Pi's active session scope, with extension visibility layered on top. With no explicit active scope it falls back to all available models.

`all` saves global `enabledModels` through Pi's `SettingsManager`. Project `enabledModels` or startup `--models` can override that global selection, and the picker reports differences. Restart Pi completely (for example `pi -c`) to synchronize the active `/model`, `/scoped-models`, and model cycle. `/reload` alone is insufficient for scoped runtime changes. Membership saves do not switch the model or reload.

Pi treats missing/empty/unresolved scopes as unrestricted. The picker rejects unchecking the last available member to avoid accidentally enabling everything. Canonical IDs, aliases, globs, case-insensitive matching and native thinking suffixes are retained; removing a pattern member expands only the affected pattern, so that pattern no longer automatically includes future additions.

## Preferences and maintenance

Sorting is global-only in `<agent-dir>/xz-pi-pmodel.json`. Trusted legacy project ordering migrates only into missing global fields; existing global values win, including explicit empty lists. Unopened projects are not scanned.

Visibility remains field-wise global/project under `providers[provider].visibleModels`. Unset project visibility inherits global. The hidden manager directly shows `[ ] global` and `[ ] project`; choose with left/right and leave the control with Space, Enter or down. Empty allowlists intentionally hide everything; new catalog additions stay hidden after an explicit allowlist has been saved.

Before startup/selection saves, maintenance uses the full known catalog, not the authentication-filtered list:

- Deleted qualified global `enabledModels` references are cleaned, while unauthenticated known models, bare aliases, globs and native thinking suffixes are preserved. Empty/error catalogs skip destructive cleanup.
- Invalid project model defaults clear their model-field pair to inherit global.
- A project visibility list containing deleted IDs clears that provider's whole local visibility override. Valid and explicit empty lists are retained.
- Local catalog refresh is bounded and disables catalog network refresh. Models removed while the picker is open cannot be saved back.

### One-time project thinking migration

On first entry to each trusted project after this upgrade, only the project's legacy `defaultThinkingLevel` and `modelThinkingLevels` fields are removed. **No backup is made, by explicit user choice.** Global thinking fields, model defaults, scoped patterns, packages, unknown fields and other projects remain untouched.

The marker `migrations.projectThinkingDefaultsRemoved` is stored in that project's extension preferences. Once completed, native thinking fields added later are not repeatedly removed. Both relevant JSON files are validated before cleanup; untrusted projects, malformed data and unreliable catalogs are skipped/reported rather than overwritten. No empty settings file is created when no legacy fields exist. A marker-write failure is reported and successful settings changes are still accounted for when refreshing caches.

The extension does not force a current-session thinking change during migration. Reload or restart Pi to refresh native caches; native session restore rules still apply.

## Accepted settings-write risk

Global defaults and scoped membership use official persistence; project settings and ordering/visibility use preserving JSON read-modify-write without additional file locks or atomic replacement. In-process serialization does not eliminate races with other Pi processes or external edits. Avoid simultaneous settings edits from multiple processes. The one-time legacy thinking cleanup intentionally does not create backups.

## Development

```bash
npm install
npm run check -w xz-pi-pmodel
npm pack --dry-run -w xz-pi-pmodel
```

Tests use Node's built-in runner with `tsx`, temporary directories and mock/stub extension contexts. No provider credentials, external services or containers are required.
