# xz-pi-login

## Unreleased

- Remove automatic account rotation, failure rescue, context continuations, startup model repair and deferred thinking writes; leave model/thinking selection and session restoration to Pi.
- Remove `/xz-login next`, its menu action and completions; select accounts explicitly through `/model` or `/pmodel`.
- Ignore retired `strategy` and `announceSwitches` preferences without migrating user files; retain passive account observations, aliases, credentials and replay identity.
- Add lifecycle and real-host offline coverage for stable selections, native defaults, reload/resume and unavailable historical models.

- Publish independent model catalogs for every native account alias, including prepared accounts; let Pi authentication control availability instead of hiding non-carrier siblings.
- Cover dual Codex accounts through startup, reload, `/pmodel` Tab all and scoped saves, plus immediate host login/logout availability and per-account credentials.

- Require Pi 1.1+ and load host Native Provider factories through a TypeScript entry.
- Remove the workspace SDK fallback; register named OAuth accounts before startup scope selection so `/pmodel` synchronization does not repeatedly omit them.
- Add offline host startup/session-replacement regression coverage alongside `/pmodel`.
- Add confirmed `/xz-login restore <provider> <alias>` recovery for existing credentials with a missing alias mapping; preserve credentials and reject foreign Provider collisions.

## 0.1.0

- Fork `pi-rotator` 0.5.2 into an independent `xz-pi-login` package.
- Add `/xz-login` with dynamic Provider completion.
- Rebind aliases to Pi's live Provider Registry so source-linked installs retain the host's current OAuth/API-key login methods.
- Discover newer host Provider families even when the extension's fallback peer package is older.
- Add interactive and non-interactive named-account preparation.
- Persist explicit account-family mappings with locked atomic updates.
- Add managed-account completion, selection, confirmation, and convergent removal.
- Retain routing, failover, usage, recovery, and Cursor transport behavior.
- Remove numbered-account discovery, legacy transport layering, and cutover.
