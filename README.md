# claude-curated-config

Set up Claude Code (`~/.claude`) on any machine from a curated catalog of settings, instructions, skills and MCP servers. One command, safe to re-run, with backups of anything it replaces.

## Install and run

```sh
curl -fsSL https://raw.githubusercontent.com/elvisgastelum/claude-curated-config/main/install.sh | bash
```

Requirements: `git` and Node.js 20 or newer. The installer enables pnpm through corepack, clones the repo to `~/.local/share/claude-curated-config` (or pulls if it is already there), builds it, adds a `ccc` command to `~/.local/bin`, and starts the TUI.

Run `ccc` again any time to add modules or update to the latest catalog (re-run the one-liner to update the code).

## The TUI

Running `ccc` in a terminal opens an interactive flow:

1. A banner with the version and the target directory, plus warnings from `doctor` (for example, when the `claude` CLI is missing).
2. Choose **Profile** (a curated set) or **Pick modules** (a multiselect with descriptions; already-applied modules are marked).
3. A plan grouped by module, with colored actions: `create`, `update`, `unchanged`, `run`, `skip`.
4. Confirm, then one spinner per module while it applies.
5. A summary with the backup location and next steps.

Press Ctrl+C at any prompt to leave without further changes.

## Commands

| Command | What it does |
|---------|--------------|
| `ccc` | Opens the TUI (in a terminal). |
| `ccc list` | Lists profiles and modules. |
| `ccc plan --profile <id>` | Shows what would change, without writing. |
| `ccc apply --profile <id>` | Applies a profile; asks for confirmation. |
| `ccc apply --module <id> --module <id>` | Applies specific modules (and what they require). |
| `ccc status` | Shows which modules are applied, partial or not applied. |
| `ccc doctor` | Checks Node, git, the `claude` CLI and the target directory. |

Global flags:

| Flag | Meaning |
|------|---------|
| `--claude-dir <path>` | Target directory. Default: `$CLAUDE_CONFIG_DIR`, then `~/.claude`. |
| `--catalog <path>` | Use another catalog directory. |
| `--cli` / `--tui` | Force non-interactive mode / the TUI. |
| `--json` | Print one JSON document to stdout (for scripts and agents). |
| `--yes`, `--dry-run` | (`apply`) Skip confirmation / preview without writing. |
| `--no-color`, `-v` | Disable colors / print the version. |

Exit codes: `0` ok, `1` a step failed, `2` usage error or refusal (for example `apply` without `--yes` outside a terminal), `3` catalog or validation error, `130` cancelled.

## Profiles and modules

| Profile | Modules |
|---------|---------|
| `minimal` | `core-settings`, `global-instructions` |
| `full` | everything in the catalog |

| Module | Installs |
|--------|----------|
| `core-settings` | Merges the settings schema and `permissions.deny` rules for `.env` files and `secrets/` into `settings.json`. |
| `global-instructions` | A starter `CLAUDE.md` with personal rules. Edit it after installing. |
| `skill-commit` | `skills/commit/SKILL.md`, a title-only commit message policy. |
| `mcp-context7` | Registers the Context7 MCP server with `claude mcp add --scope user` (skipped if `claude` is not installed). |

To add your own, see [packages/catalog/README.md](packages/catalog/README.md).

## Safety

- Writes only inside the target directory. Catalog paths that are absolute or contain `..` are rejected. Only `command` steps (such as `claude mcp add`) act outside it.
- Before replacing a file that differs, the old version is copied to `<claude-dir>/.ccc-backups/<timestamp>/`.
- `json-merge` keeps your existing keys and array entries; it only adds what the catalog defines (catalog values win for keys present in both).
- Idempotent: a second apply reports everything `unchanged`.
- `--dry-run` and `plan` never write anything.
- The catalog contains no secrets.

## Agents

Coding agents can set up a machine with the non-interactive mode. See [AGENTS.md](AGENTS.md).

## Development

```sh
pnpm install
pnpm build        # bundles packages/cli/dist/index.js
pnpm test         # builds, then runs unit and integration tests
pnpm lint         # biome
pnpm typecheck
pnpm ccc --cli plan --profile minimal --claude-dir /tmp/claude-test
```
