# Changesets

`@marinoscar/hexactra-agent` and `@marinoscar/hexactra-browser-agent` are versioned together (`fixed` in `config.json`) with [Changesets](https://github.com/changesets/changesets), as the Vault packages are. The apps (`api`, `web`, `cli`, `mcp-ui`), `@app/shared` and the SDK are ignored: they are versioned by `hexactra deploy` (console `AGENTS.md`, "Commits").

A change to a package is a changeset: `npm run changeset` from `console/`, commit the generated file with the change.

**Publishing is prepared and left off.** There is no release workflow and no `npm publish` here: `npm run check:package-pack` only dry-runs `npm pack` and checks the tarballs. Turning publishing on is a separate decision (`docs/decisions/agent-packages.md`).
