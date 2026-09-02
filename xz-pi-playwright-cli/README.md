# xz-pi-playwright-cli

Project-local [Pi](https://github.com/badlogic/pi-mono) package that exposes Microsoft's official `playwright-cli` skill.

## Prerequisite

Node.js 18 or newer and the Playwright CLI must be available globally:

```bash
npm install -g @playwright/cli@latest
playwright-cli --help
```

## Install in this project

From the repository root:

```bash
pi install -l ./xz-pi-playwright-cli
```

Restart Pi after installation. Pi will discover the `playwright-cli` skill automatically, or it can be invoked explicitly:

```text
/skill:playwright-cli
```

## Verify

Ask Pi to automate a page, or verify the CLI directly:

```bash
playwright-cli open https://example.com
playwright-cli snapshot
playwright-cli close
```

## Update the vendored skill

Copy `skills/playwright-cli/` from the upstream repository and update `UPSTREAM.md` with the new package version and commit.

## License

The vendored skill files originate from Microsoft Playwright CLI and are provided under the Apache License 2.0. See [LICENSE](LICENSE) and [UPSTREAM.md](UPSTREAM.md).
