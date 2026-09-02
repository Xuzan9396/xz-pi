# xz-pi

A monorepo of independently installable packages for [pi](https://github.com/badlogic/pi-mono).

> Pi packages can execute code with your user permissions. Review a package before installing it.

## Packages

| Package | Description | Install |
| --- | --- | --- |
| [`xz-pi-playwright-cli`](./xz-pi-playwright-cli) | Playwright CLI skill for browser automation and testing | `pi install npm:xz-pi-playwright-cli` |
| [`xz-pi-websearch`](./xz-pi-websearch) | Web search and web content tools | `pi install npm:xz-pi-websearch` |
| [`xz-pi-vim`](./xz-pi-vim) | Vim-style modal editing extension | `pi install npm:xz-pi-vim` |

Each package is published separately, so installing one does not install or enable the others.

## Install

Install only the packages you need:

```bash
pi install npm:xz-pi-vim
pi install npm:xz-pi-websearch
pi install npm:xz-pi-playwright-cli
```

Use `-l` for a project-local installation written to `.pi/settings.json`:

```bash
pi install -l npm:xz-pi-vim
```

Install a specific version to pin it:

```bash
pi install npm:xz-pi-vim@0.1.0
```

## Update

Update one unpinned package:

```bash
pi update npm:xz-pi-vim
```

Update all installed Pi packages:

```bash
pi update --extensions
```

A package installed with an explicit version such as `@0.1.0` remains pinned. Install the desired version explicitly to change it.

## Remove

```bash
pi remove npm:xz-pi-vim
pi remove npm:xz-pi-websearch
pi remove npm:xz-pi-playwright-cli
```

Add `-l` when removing a project-local installation:

```bash
pi remove -l npm:xz-pi-vim
```

## Versioning and releases

Packages use independent [Semantic Versioning](https://semver.org/) managed by [Changesets](https://github.com/changesets/changesets):

- `patch` (`0.1.0` → `0.1.1`): compatible bug fix
- `minor` (`0.1.0` → `0.2.0`): backward-compatible feature
- `major` (`0.1.0` → `1.0.0`): breaking change

After changing a package:

```bash
npm install
npm run changeset
```

Select only the changed package(s), choose the appropriate version bump, and commit the generated `.changeset/*.md` file with your changes. After the commit reaches `main`, GitHub Actions opens or updates a **chore: release packages** pull request. Merging that PR publishes only the packages whose versions changed.

### Maintainer setup

The repository must contain an Actions repository secret named `NPM_TOKEN` with an npm access token allowed to publish all three packages. The token must never be committed to the repository.

CI and release workflows are located in [`.github/workflows`](./.github/workflows):

- `ci.yml` runs type checks, tests, and npm package dry runs.
- `release.yml` maintains the Changesets release PR and publishes packages to npm with provenance.
