# @claude-curated/catalog

The curated catalog: plain data that `ccc` applies to a Claude Code config dir (`~/.claude` by default). No build step; `index.js` only exports `catalogDir`.

```
modules/<id>/module.json   # module definition
modules/<id>/<assets>      # files referenced by its steps
profiles/<id>.json         # named module sets
```

## Add a module

1. Create `modules/<id>/` (lowercase kebab-case; the directory name must equal `id`).
2. Add the assets the module installs next to `module.json`.
3. Write `module.json`:

```json
{
  "id": "my-module",
  "name": "My module",
  "description": "One sentence shown in the TUI and in `ccc list`.",
  "tags": ["optional"],
  "requires": ["core-settings"],
  "steps": [
    { "type": "file", "src": "agent.md", "dest": "agents/agent.md" },
    { "type": "file", "src": "hook.sh", "dest": "hooks/hook.sh", "mode": "symlink" },
    { "type": "json-merge", "src": "settings.json", "dest": "settings.json" },
    {
      "type": "command",
      "run": ["claude", "mcp", "add", "--scope", "user", "name", "--", "npx", "-y", "pkg"],
      "check": ["claude", "mcp", "get", "name"],
      "requiresBin": "claude"
    }
  ]
}
```

Step types:

| Type | Behavior |
|------|----------|
| `file` | Copies `src` (relative to the module dir) to `dest` (relative to the Claude dir). `"mode": "symlink"` links to the catalog copy instead. |
| `json-merge` | Deep-merges `src` into `dest`: objects merge, arrays are unioned without duplicates, catalog scalars win, existing keys are kept. A `dest` that is a symlink to a real file (e.g. a dotfiles repo) is merged through the link. |
| `command` | Runs `run` as an argv (no shell). Skipped when `check` exits 0, or when `requiresBin` is not on `PATH`. |

Rules:

- `dest` must stay inside the Claude dir (no absolute paths, no `..`); the loader rejects anything else.
- Never put secrets, tokens or machine-specific paths in the catalog.
- Pin package versions in `command` steps (e.g. `npx -y pkg@1.2.3`) so every machine gets the same thing.
- Permission rules for paths should use `**/` globs (`Read(**/.env)`) so they match at any depth; `./` only matches the project root.
- Give every `command` step a `check` so re-running is idempotent.
- `requires` lists modules that must be applied first; cycles are rejected.

## Add a profile

Create `profiles/<id>.json`:

```json
{
  "id": "my-profile",
  "name": "My profile",
  "description": "What this set is for.",
  "order": 50,
  "modules": ["core-settings", "my-module"]
}
```

`order` is optional: the TUI and `ccc list` show profiles by ascending `order` (`minimal` is 10, `full` 20, `personal` 30), then by id; profiles without one come last.

## Validate

```sh
pnpm test                       # includes a test that loads this catalog
pnpm ccc --cli list --json      # after pnpm build
```
