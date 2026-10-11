# claude-curated-config

Set up Claude Code (`~/.claude`) on any machine from a curated catalog of settings, instructions, skills and MCP servers. One command, safe to re-run, with backups of anything it replaces.

## Install and run

```sh
curl -fsSL https://raw.githubusercontent.com/elvisgastelum/claude-curated-config/main/install.sh | bash
```

Requirements: `git` and Node.js 20 or newer (the single source is `engines.node` in `package.json`; the installer and `ccc doctor` both read it). The installer enables pnpm through corepack, clones the repo to `~/.local/share/claude-curated-config` (or pulls if it is already there), builds it, adds a `ccc` command to `~/.local/bin`, and starts the TUI.

Run `ccc` again any time to add modules or update to the latest catalog (re-run the one-liner to update the code).

## The TUI

Running `ccc` in a terminal opens an interactive flow:

1. A banner with the version and the target directory, plus warnings from `doctor` (for example, when the `claude` CLI is missing).
2. Choose **Profile** (a curated set) or **Pick modules** (a multiselect with descriptions; already-applied modules are marked).
3. A plan grouped by module, with colored actions: `create`, `update`, `unchanged`, `run`, `skip`.
4. If one of your settings differs from the catalog value, one prompt per conflict shows both values: **Use catalog value** or **Keep my value** (or apply that choice to all remaining conflicts).
5. Confirm, then one spinner per module while it applies.
6. A summary with the backup location and next steps.

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
| `ccc capture` | Imports your current config into catalog modules and a `personal` profile. |

Global flags:

| Flag | Meaning |
|------|---------|
| `--claude-dir <path>` | Target directory. Default: `$CLAUDE_CONFIG_DIR`, then `~/.claude`. |
| `--catalog <path>` | Use another catalog directory. |
| `--cli` / `--tui` | Force non-interactive mode / the TUI. |
| `--json` | Print one JSON document to stdout (for scripts and agents). |
| `--yes`, `--dry-run` | (`apply`) Skip confirmation / preview without writing. |
| `--on-conflict <ask\|catalog\|keep>` | (`plan`, `apply`) Default decision for settings that differ from the catalog. |
| `--resolve <module>:<pointer>=<catalog\|keep>` | (`plan`, `apply`) Decide one conflict, e.g. `--resolve 'core-settings:/model=keep'`. Repeatable. |
| `--no-color`, `-v` | Disable colors / print the version. |

Exit codes: `0` ok, `1` a step failed (or, with `--dry-run`, would fail), `2` usage error or refusal (for example `apply` without `--yes` outside a terminal), `3` catalog or validation error, `130` cancelled.

## Profiles and modules

| Profile | Modules |
|---------|---------|
| `minimal` | `core-settings`, `global-instructions` |
| `full` | everything in the catalog |
| `personal` | your captured modules (after `ccc capture`) |

Profiles are listed in the TUI and `ccc list` by their `order` field (lowest first).

| Module | Installs |
|--------|----------|
| `core-settings` | Merges the settings schema and `permissions.deny` rules `Read(**/.env)`, `Read(**/.env.*)` and `Read(**/secrets/**)` (any depth) into `settings.json`. |
| `global-instructions` | A starter `CLAUDE.md` with personal rules. Edit it after installing. |
| `skill-commit` | `skills/commit/SKILL.md`, a title-only commit message policy. |
| `mcp-context7` | Registers the Context7 MCP server (`@upstash/context7-mcp`, pinned version) with `claude mcp add --scope user` (skipped if `claude` is not installed). |

To add your own, see [packages/catalog/README.md](packages/catalog/README.md).

## Safety

- Writes only inside the target directory. Catalog paths that are absolute or contain `..` are rejected. Only `command` steps (such as `claude mcp add`) act outside it.
- Before replacing a file that differs, the old version is copied to `<claude-dir>/.ccc-backups/<timestamp>/` (a new directory per run; existing backups are never overwritten). A replaced symlink is backed up as a symlink with the same target.
- Writes are atomic (temp file + rename), so an interrupted run never leaves a half-written file.
- A failing step does not stop the run: the rest of its module and the modules that require it are skipped, everything else is applied, and the report lists every step (exit code `1`).
- If the installer fails on a fresh install it removes the partial checkout; if an update fails it restores and rebuilds the previous version.
- `json-merge` keeps your existing keys and array entries and adds what the catalog defines. When one of your values differs from the catalog value, `ccc` asks which to keep (TUI) or refuses with exit `2` until you pass `--resolve`/`--on-conflict` (CLI). Nothing is written until every conflict is decided.
- Idempotent: a second apply reports everything `unchanged`.
- `--dry-run` and `plan` never write anything.
- The catalog contains no secrets: captured secrets are replaced with `${CCC_SECRET_*}` placeholders and filled in at apply time.

## Capture your current setup

Turn the Claude Code config you already have into catalog modules, so you can commit it and apply it on other machines:

```sh
ccc capture                         # TUI: pick items, review redactions, write
ccc capture --dry-run               # preview without writing
ccc --cli capture --yes --json      # non-interactive (agents, scripts)
```

It reads `~/.claude` (`CLAUDE.md`, `settings.json`, the status line script referenced by settings, `skills/*/`, `agents/*.md`, `commands/**/*.md`, `output-styles/*.md`) and the user-scope `mcpServers` from `~/.claude.json`, and writes one module per item into the catalog (`personal-settings`, `personal-claude-md`, `personal-skill-<name>`, `personal-mcp-<name>`, ...) plus a `personal` profile. Caches and state (`projects/`, `todos/`, `plugins/`, `history*`, logs, `.ccc-backups/`, ...) are ignored; plugins are captured through `enabledPlugins` and `extraKnownMarketplaces` in `settings.json`. MCP servers become `claude mcp add-json --scope user` commands.

Secrets are never written. Values under secret-looking keys (`token`, `secret`, `password`, `api_key`, `auth`, ...) and strings shaped like credentials (`sk-...`, `ghp_...`, `github_pat_...`, `xox?-...`, `AKIA...`, private keys, JWTs, long random strings) become `${CCC_SECRET_<NAME>}` placeholders, and the module declares them under `secrets`. Values that only reference environment variables (`${GITHUB_TOKEN}`) are kept. Capture prints every redaction (where and which placeholder, never the value).

Applying a module with secrets asks for each value in the TUI (masked input); in `--cli` mode it reads the environment variable of the same name and exits `2` (`secrets_missing`, listing the names) when one is missing, before writing anything.

Re-running capture updates the personal modules in place (unchanged files are not rewritten). Always review the result with `git diff` before committing.

| Flag | Meaning |
|------|---------|
| `--out <dir>` | Catalog directory to write (default: the catalog in use, `--catalog` or the bundled one). |
| `--claude-json <path>` | Where to read user MCP servers (default `~/.claude.json`, or `<claude-dir>/.claude.json` for a custom `--claude-dir`). |
| `--include <kind>` | Only these kinds (repeatable): `claude-md`, `settings`, `statusline`, `skill`, `agent`, `command`, `output-style`, `mcp`. |
| `--dry-run`, `--yes` | Preview / write without confirmation (required outside a terminal). |

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
