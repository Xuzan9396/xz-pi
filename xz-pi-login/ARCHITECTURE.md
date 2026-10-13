# xz-pi-login architecture

## Identity

`auth.json` Provider IDs are the only selectable runtime identities. Named aliases such as
`openai-codex-work` and `openai-codex-xuzan` remain independent Pi Providers with their own
credentials and model catalogs. The extension does not register `xz-login-*` virtual models
and never copies credentials between accounts.

`config/xz-pi-login/accounts.json` records ownership and the base Provider used to recreate a
named alias. `models.json` stores the alias Provider definition when required. Authentication
continues to be owned by Pi's native OAuth/API-key runtime.

## Selection and defaults

Pi and the user own model and thinking selection. For an ordinary new session, the extension
selects the current trusted project's physical `defaultProvider/defaultModel` pair when valid,
then falls back to the global pair. CLI selection, reload, resume, fork, and recorded model
history are preserved. Thinking is never changed by the extension.

The selected account is never replaced automatically after quota, authentication, timeout, or
transport failures. Users switch accounts explicitly through `/model` or `/pmodel`.

## Catalog and cleanup

Consumers read only the top-level Provider IDs from `auth.json`; credential payloads never enter
catalog events, logs, settings, or preference files. `/pmodel` intersects those IDs with Pi's
usable model catalog, so unconfigured Providers and empty catalogs are not displayed.

On startup, reload, account removal, and `/pmodel` maintenance, exact references to deleted
Providers or models are removed from the global and current trusted-project defaults, scoped
configuration, ordering, and visibility. Default provider/model fields are removed as a pair.
Globs, bare model expressions, thinking fields, and unrelated settings are retained. Other
projects are never scanned. UI-capable sessions receive a warning and must select replacements
manually.

## Legacy metadata

`config/xz-pi-login/pools.json` is compatibility metadata only. Its old `preferred` values may be
read once to map an `xz-login-<base>/<model>` setting back to a physical account; if that account
is unavailable, auth.json order chooses the first same-base account exposing the same model.
The file also retains resumable account-removal records already in progress. It no longer routes
requests, publishes snapshots, cools accounts, or triggers failover.

## Removal and safety

Confirmed removal deletes exactly the selected credential, alias Provider definition, alias
mapping, and exact configuration references. Base Providers and sibling accounts are retained.
An active account can be removed only while the current window is idle; no replacement is
selected. Persistent credential/config mutations keep their existing validation and atomic-write
behavior. Secrets and provider payloads are never included in diagnostic output.
