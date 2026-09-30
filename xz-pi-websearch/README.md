# xz-pi-websearch

A deliberately small Pi package for two jobs:

- `web_search`: provider/model-aware hosted web search with a concise cited answer.
- `fetch_content`: public web-page extraction plus GitHub-aware repository, file, PR, and issue handling.

It intentionally omits video, YouTube, images, PDFs, browser cookies, curator UI, source checking, result-cache tools, and multi-provider fan-out. One search request uses exactly one selected provider/model route.

## Why

`pi-web-access` is broad and registers four large tool schemas. This package keeps two compact tool schemas, avoids a secondary curator call, and bounds returned content. Source-code size itself is not prompt token usage; the main savings come from fewer tools and bounded results.

## Supported search routes

| Configured route | Search protocol | Local verification |
|---|---|---|
| `openai-codex*` models using Codex Responses | ChatGPT Codex `web_search` | Verified with personal and work aliases |
| `openai` models using OpenAI Responses | OpenAI Responses `web_search` | Adapter supported; depends on API auth |
| `github-copilot` models using OpenAI Responses | Copilot Responses `web_search` | Verified with Grok 4.7 |
| `xai` models using OpenAI Responses | xAI Responses `web_search` | Adapter and mock tested; live auth not verified |
| `xai-oci/xai.grok-4.7` | OCI-hosted xAI Responses `web_search` | Search-only adapter; live verified |
| `anthropic` models using Anthropic Messages | Anthropic `web_search_20250305` | Adapter and mock tested; live auth not verified |

Most choices are built dynamically from Pi's current model registry and authenticated providers. The additional `xai-oci/xai.grok-4.7` route is search-only: it is discovered from macOS Keychain availability and is not registered as a Pi chat model. Protocol compatibility makes a registry model a candidate, while the provider remains authoritative and may reject server-side search at request time. For example, `github-copilot/grok-4.7` was verified, whereas `github-copilot/claude-opus-5.5` uses the Anthropic wire API under a non-Anthropic provider and is not offered as an Anthropic hosted-search route.

## Requirements

- Pi with at least one supported provider login, or the provider's API-key environment variable.
- For `xai-oci`: macOS with a generic-password item for the current `USER` (falling back to `LOGNAME`), service `pi-xai-oci-api-key`.
- The Codex alias extension when using provider IDs such as `openai-codex-personal` and `openai-codex-work`.
- `git` for repository cloning.
- `gh` is recommended for private repositories and richer PR/issue data. Public GitHub data falls back to the REST API.

Registry-provider credentials are resolved through Pi's model registry. The OCI key is read with the parameterized equivalent of `security find-generic-password -a "$USER" -s "pi-xai-oci-api-key" -w`, cached only for the current session, and never written to settings or session entries.

## Install

The old package and this package both use the names `web_search` and `fetch_content`; do not keep both enabled.

```bash
pi remove npm:pi-web-access
pi install /Users/admin/go/src/myai/xz-pi/xz-pi-websearch
```

Restart Pi after switching packages. To test without installing permanently:

```bash
pi -e /Users/admin/go/src/myai/xz-pi/xz-pi-websearch/index.ts
```

## Tools

### `web_search`

Default current-model/provider selection:

```typescript
web_search({
  query: "Pi coding agent extension documentation",
  numResults: 5,
  recencyFilter: "month",
  domainFilter: ["github.com"]
})
```

With no explicit route, a new session defaults to the exact current model when it supports hosted search, otherwise to a search-capable model from the same provider. It does not cross providers unless `Automatic` was explicitly selected.

Explicit provider with its preferred search model:

```typescript
web_search({ query: "latest TypeScript release", provider: "github-copilot" })
```

Exact route:

```typescript
web_search({
  query: "latest TypeScript release",
  provider: "github-copilot",
  model: "grok-4.7"
})
```

`model` requires `provider`. Explicit routes are strict: an unavailable, unauthenticated, or unsupported route returns an error instead of silently using another account.

Selection precedence:

1. `provider` and optional `model` explicitly supplied to this invocation.
2. The current session route selected by `/xz-search`.
3. The saved default loaded when the session starts.
4. `Current model/provider` when no valid version 3 default exists.

An explicit tool route applies to that invocation only; the next call returns to the current session route. `Current model/provider` first uses the exact current model. If that model is not a search candidate, it chooses the preferred dynamically configured search model from the **same provider only**; it never crosses providers. `Automatic` starts the same way but may select another authenticated provider. It selects one route up front and does not retry provider failures elsewhere.

The tool result details report the route that actually ran and the source count.

### `/xz-search`

Run the command without arguments:

```text
/xz-search
```

The selector combines authenticated registry routes with the search-only OCI route when its Keychain item is available. It marks the active session route with `(current)` and the startup route with `(default)`.

- `Enter`: use the highlighted route for the current session only.
- `Ctrl+S`: use it now and save it as the default for new sessions.
- `Esc`: cancel without changing either value.

`/resume` restores the selected route from that session, `/fork` inherits the active branch, and `/new` loads the saved default. RPC clients use a normal selector followed by a save-default confirmation.

The global default is stored at:

```text
~/.pi/agent/xz-pi-websearch/settings.json
```

The file contains only schema version 3 and a `default` preference; session choices are stored as Pi custom entries that are excluded from model context. Both contain only modes and provider/model IDs. Version 1 and 2 files are intentionally ignored and reset to `Current model/provider`. Version 3 writes use an atomic same-directory rename and `0600` permissions. A fixed route remains strict and reports an error if it becomes unavailable.

### `fetch_content`

```typescript
fetch_content({ url: "https://example.com/docs" })
fetch_content({ url: "https://github.com/owner/repo" })
fetch_content({ url: "https://github.com/owner/repo/blob/main/src/index.ts" })
fetch_content({ url: "https://github.com/owner/repo/pull/123" })
```

Regular pages support HTML, Markdown, JSON, XML, JavaScript, and plain text. HTML is reduced to its readable body and converted to Markdown. Binary files and PDFs are intentionally unsupported.

GitHub behavior:

- Repository roots are shallow-cloned and return a local path.
- `tree` and `blob` URLs list or read repository content.
- PRs and issues use `gh` first, with public REST fallback.
- Repositories reported above 350MB use a lightweight GitHub API view unless `forceClone: true` is passed.
- Temporary pages and clones are removed on session shutdown.

## Provider-specific filters

`domainFilter` entries are allowed domains; prefix a domain with `-` to exclude it.

- OpenAI/Codex: up to 20 allowed and 20 blocked domains.
- xAI and Copilot Grok: at most 5 allowed or 5 excluded domains; the two forms cannot be combined.
- `xai-oci`: domain filtering has not been verified and any non-empty `domainFilter` is rejected.
- Anthropic: allowed and blocked domains cannot be combined.

Invalid or unsupported combinations return an error. The package never silently truncates filters, drops an OCI filter, or changes an allowlist into a blocklist.

## Safety, cost, and output limits

- Hosted search consumes the selected provider's subscription allowance, AI credits, or API balance.
- Tokens are never written to settings, session entries, test artifacts, or cache files and are replaced in provider error text before display.
- The OCI key is held only in memory for the active session and its reference is cleared on session shutdown/replacement/reload.
- OCI Keychain lookup uses a 5-second timeout; OCI search uses the existing 60-second search timeout. Both honor cancellation without provider fallback.
- OCI requires a completed response with `web_search_call`, caps successful responses at 5MB, and bounds displayed error text after redaction.
- Provider error bodies remain visible in bounded form for diagnostics and may contain other account metadata.
- Direct fetching accepts public HTTP(S) URLs only.
- Localhost, private, link-local, reserved, and documentation IP ranges are blocked before each redirect.
- Fetch timeout: 30 seconds; search/clone timeout: 60 seconds.
- HTTP response limit: 5MB; redirect limit: 5.
- At most 12,000 characters are returned inline. Full extracted pages are stored in a private temporary Markdown file and can be continued with Pi's built-in `read` tool.

## Development

```bash
npm install
npm run check
```
