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
| `json-merge` | Deep-merges `src` into `dest`: objects merge, arrays are unioned without duplicates, existing keys are kept; a value that differs from the user's is a conflict the user decides (`--resolve`/`--on-conflict`, or a TUI prompt). A `dest` that is a symlink to a real file (e.g. a dotfiles repo) is merged through the link. |
| `command` | Runs `run` as an argv (no shell), or `shell` as a bash script (`bash -o pipefail -c`, so `curl ... \| bash` fails when curl fails). Exactly one of `run`/`shell`. Skipped when `check` (argv) or `checkShell` (bash) exits 0, when `requiresBin` is not on `PATH`, when the OS is not in `os`, or when `globalOnly` is set and the target is not `~/.claude`. |

`file` steps accept `"preserveBlocks": true` (copy mode): managed blocks that installers added to the destination (`<!-- BEGIN name -->`...`<!-- END name -->` or `<!-- name -->`...`<!-- /name -->`) are kept, appended after the copied content, so re-applying stays idempotent.

`command` step options:

| Field | Meaning |
|-------|---------|
| `os` | `["darwin", "linux", "win32"]` subset; other systems skip the step with a reason. |
| `env` | Extra environment variables. Values expand `${CCC_SECRET_*}`, `${CCC_CLAUDE_DIR}` (the target Claude dir), `${CCC_CLAUDE_JSON}` (its `.claude.json`), `~/`, `$HOME` and `${NAME:-default}` (from the caller's environment). |
| `interactive` | Stdin is `/dev/null` by default so installers never prompt; `true` lets the step use the terminal when `ccc` runs in a terminal (TUI or interactive `apply`). |
| `globalOnly` | The tool always writes to `~/.claude` (it has no option for another dir): skip unless the target is `~/.claude`. |

Every command also gets `CCC_CLAUDE_DIR` and `CCC_CLAUDE_JSON` in its environment. `$CCC_PLATFORM` overrides the detected OS (for tests).

## Provides

A module that installs things through an external installer declares what it owns, so `ccc capture` does not copy those items into personal modules:

```json
"provides": {
  "paths": ["skills/commit", "hooks/commit-guard.sh"],
  "settings": ["/includeCoAuthoredBy"],
  "hooks": ["hooks/commit-guard.sh"],
  "claudeMdBlocks": ["claude-commit-skill"],
  "mcpServers": ["kaneo"]
}
```

| Key | Matches |
|-----|---------|
| `paths` | Globs relative to the Claude dir (`*`, `**`, `?`); a match covers everything below it. |
| `settings` | JSON pointers in `settings.json` (removed from the captured settings). |
| `hooks` | Substrings of `settings.json` hook commands (those hook entries are removed). |
| `claudeMdBlocks` | Managed CLAUDE.md block names, globs allowed (`gentle-ai:*`); the blocks are stripped from the captured CLAUDE.md. |
| `mcpServers` | User-scope MCP server names in `.claude.json`. |

Capture also never takes `skills/synced` or `skills/homelab-service-manager` (`CAPTURE_IGNORE` in core). Modules whose id starts with `personal-` never hide anything.

Rules:

- `dest` must stay inside the Claude dir (no absolute paths, no `..`); the loader rejects anything else.
- Never put secrets, tokens or machine-specific paths in the catalog.
- Pin package versions in `command` steps (e.g. `npx -y pkg@1.2.3`) so every machine gets the same thing.
- Permission rules for paths should use `**/` globs (`Read(**/.env)`) so they match at any depth; `./` only matches the project root.
- Give every `command` step a `check` or `checkShell` so re-running is idempotent, and a `requiresBin` so a missing prerequisite skips the step instead of failing it.
- Prefer the upstream installer of a tool over a snapshot of its files, and declare what it writes under `provides`.
- Tool installs (`tool-*`) set `"os": ["darwin", "linux"]`; a setup module `requires` its tool so it runs after the install.
- `requires` lists modules that must be applied first; cycles are rejected.

## Secrets

A module that needs a secret declares it and uses a `${CCC_SECRET_<NAME>}` placeholder in a json-merge source, a copied text file or a command argument:

```json
{
  "secrets": [{ "name": "CCC_SECRET_GITHUB_TOKEN", "description": "GitHub token for the MCP server" }],
  "steps": [{ "type": "command", "run": ["claude", "mcp", "add-json", "--scope", "user", "github", "{\"headers\":{\"Authorization\":\"Bearer ${CCC_SECRET_GITHUB_TOKEN}\"}}"] }]
}
```

`ccc` fills placeholders at apply time (TUI prompt, or the environment variable of the same name in `--cli` mode). `ccc capture` generates these automatically. Symlinked files are not substituted.

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
