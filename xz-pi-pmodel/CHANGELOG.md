# xz-pi-pmodel

## 1.0.0

### Major Changes

- b4f3e60: update

## 0.0.0

- Initial development version of the provider-grouped `/pmodel` selector.
- Make `all` a checklist-only editor for global official `enabledModels`, with immediate scoped checkmarks, project/session override notices, and restart guidance.
- Preserve other scoped patterns and thinking levels when removing a glob member; reject removing the last available member.
- Highlight current, project default and global default independently with bold blue/yellow/green marks, including folded providers and narrow checkboxes.
- Automatically prune deleted qualified references from global `enabledModels` at session startup, picker opening, and membership saves, preserving known unauthenticated models and patterns.
- Make provider/model sorting global-only with global-first migration of trusted legacy project sorting.
- Automatically reset conflicting trusted project model and visibility overrides; preserve valid settings, explicit empty visibility and unknown fields, and skip unreliable catalogs.
- Set defaults directly using per-row global/project checkboxes in scoped mode; replace within each column, retain global selection, and allow project unchecking to inherit global.
- Show Pi's actual thinking level read-only; remove thinking controls and layer-switch shortcuts.
- Choose global/project visibility directly in hidden management, independently of default columns.
- Migrate legacy project thinking fields once without backup, preserve globals, and stop deleting later native thinking configuration.
- Serialize default saves, update checks after persistence, and reload default caches only after closing.
- Refresh local catalog metadata before interactive saves and reject choices removed or no longer supported while the picker was open.
