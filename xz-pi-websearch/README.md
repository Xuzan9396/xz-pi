# xz-pi-websearch

A deliberately small Pi package for two jobs:

- `web_search`: OpenAI/Codex Hosted Web Search with a concise cited answer.
- `fetch_content`: public web-page extraction plus GitHub-aware repository, file, PR, and issue handling.

It intentionally omits video, YouTube, images, PDFs, browser cookies, curator UI, source checking, result-cache tools, and non-OpenAI search providers.

## Why

`pi-web-access` is broad and registers four large tool schemas. This package keeps only two short schemas and bounds returned content, reducing the tool/context overhead for users who mainly search and read technical material.

Source-code size itself is not prompt token usage. The main savings come from fewer/smaller tool definitions, no secondary curator summary call, no multi-provider fan-out, no full-page inline results, and a 12,000-character inline output bound.

## Requirements

- Pi with an OpenAI Codex login (`/login`), or `OPENAI_API_KEY`.
- `git` for repository cloning.
- `gh` is recommended for private repositories and richer PR/issue data. Public GitHub data falls back to the REST API.

## Install

The old package and this package both use the names `web_search` and `fetch_content`; do not keep both enabled.

```bash
pi remove npm:pi-web-access
pi install /Users/admin/go/tmp_xz/xz-pi-websearch
```

Restart Pi after switching packages. To test without installing permanently:

```bash
pi -e /Users/admin/go/tmp_xz/xz-pi-websearch/index.ts
```

## Tools

### `web_search`

```typescript
web_search({
  query: "Pi coding agent extension documentation",
  numResults: 5,
  recencyFilter: "month",
  domainFilter: ["github.com", "-example.com"]
})
```

Authentication order:

1. Pi's `openai-codex` login, preferring an available `terra` model.
2. Pi's regular `openai` login.
3. `OPENAI_API_KEY`, using `gpt-5.6-terra` by default.

Set `OPENAI_SEARCH_MODEL` to override the API-key fallback model. Search uses only official OpenAI/ChatGPT endpoints.

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

## Safety and output limits

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
