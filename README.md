# claude-curated-config

Set up Claude Code (`~/.claude`) on any machine from a curated catalog of settings, instructions, skills and MCP servers. One command, safe to re-run, with backups of anything it replaces.

## Install and run

```sh
curl -fsSL https://raw.githubusercontent.com/elvisgastelum/claude-curated-config/main/install.sh | bash
```

Requirements: `git` and Node.js 20.12.0 or newer (the single source is `engines.node` in `package.json`; the installer and `ccc doctor` both read it). The installer enables pnpm through corepack, clones the repo to `~/.local/share/claude-curated-config` (or pulls if it is already there), builds it, adds a `ccc` command to `~/.local/bin`, and starts the TUI.

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
| `ccc status` | Shows which modules are applied, partial, not applied, only differ by settings conflicts (`conflicts`), or cannot be checked until their secrets are set (`needs-secrets`). Accepts `--on-conflict` and `--resolve` like `plan`; secret values come from `CCC_SECRET_*` environment variables. Decisions are never remembered between runs. |
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
| `full` | a generic public setup: `core-settings`, `global-instructions`, `skill-commit`, `mcp-context7` |
| `personal` | the maintainer's machine: `core-settings`, every tool and installer module below except `skill-configure-env` (not on npm yet) plus `mcp-context7` (asks for `KANEO_URL`); `ccc capture` appends `personal-*` modules for what is left |

Profiles are listed in the TUI and `ccc list` by their `order` field (lowest first).

### Installers and tools

Most modules run the upstream installer of a tool or skill instead of copying a snapshot. Remote installers are pinned to a commit (see [Installer pins](#installer-pins)), so every machine runs the same reviewed script. Each one has a check (it runs only when the thing is missing) and declares what it `provides`, so `ccc capture` does not duplicate it.

- Platforms: macOS and Linux. Tool installs use Homebrew (`brew`, also Homebrew on Linux) or `npm`; without them the step is skipped with a reason. Other systems skip them.
- Prerequisites (`ccc doctor` checks them, all optional): `bash`, `curl`, `jq`, `npm`/`npx`, and `brew` on macOS.
- Tool setup modules (`gentle-ai-claude`, `engram-claude`, `codegraph-claude`, `herdr-claude`, `skill-configure-env`) can only write to `~/.claude`; for another `--claude-dir` they are skipped. The skill installers and the status line honour `--claude-dir`.
- Installers never prompt: their stdin is `/dev/null`.

| Module | Installs |
|--------|----------|
| `core-settings` | Merges the settings schema and `permissions.deny` rules `Read(**/.env)`, `Read(**/.env.*)` and `Read(**/secrets/**)` (any depth) into `settings.json`. |
| `global-instructions` | A starter `CLAUDE.md` with personal rules. Edit it after installing. |
| `skill-commit` | Runs the [claude-commit-skill](https://github.com/elvisgastelum/claude-commit-skill) installer: title-only commit skill, commit-guard hook, attribution settings, a managed CLAUDE.md block. |
| `mcp-context7` | Registers the Context7 MCP server (`@upstash/context7-mcp`, pinned version) with `claude mcp add --scope user` (skipped if `claude` is not installed). |
| `skill-kaneo` | Runs the kaneo-work-tracking-skill installer (skill, CLAUDE.md block, `kaneo` MCP server). Needs the input `KANEO_URL`, your Kaneo base URL: asked in the TUI, read from the `KANEO_URL` env var in `--cli` mode (exit `2` `inputs_missing` without it). |
| `skill-continue` | Runs the claude-continue-skill installer (`skills/continue`). |
| `skill-configure-env` | `npx @elvisgastelum/configure-env install skill ...` (Node >= 22). Not in `personal`: the package is not published on npm yet, so the step fails until it is; select it explicitly once it is. |
| `statusline` | Runs the claude-statusline installer (`statusline.sh` + `statusLine` setting; replaces an existing one). |
| `tool-gentle-ai`, `tool-engram`, `tool-herdr` | `brew install` the tool when it is not on `PATH`. |
| `tool-codegraph` | `npm install -g @colbymchenry/codegraph@1.6.0` when `codegraph` is not on `PATH`. |
| `gentle-ai-claude` | `gentle-ai install --agent claude-code --scope global --preset full-gentleman` (once; checked with `jq` on `installed_agents` in `~/.gentle-ai/state.json`). It also registers the engram MCP server and its permission deny rules. |
| `engram-claude` | `engram setup claude-code`, only when `~/.claude.json` still has no user-scope `engram` MCP server after `gentle-ai-claude`. |
| `codegraph-claude` | `codegraph install --yes --target claude --location global` (MCP server, prompt hook, `mcp__codegraph__*` auto-allow), unless a user-scope `codegraph` MCP server exists. |
| `herdr-claude` | `herdr integration install claude`, unless `herdr integration status` reports `claude: current`. |
| `herdr-config` | Runs the herdr-config installer, which writes outside the Claude dir (`~/.config/herdr`, `~/.local/bin/herdr-config`, `~/.agents/skills/herdr-config`). |

MCP checks read the user-scope `.mcpServers.<name>` of `~/.claude.json` with `jq` (a project-scope server does not count), so those modules also need `jq`.

### Installer pins

Every `curl ... | bash` installer URL names a commit SHA, and the step passes the same commit as `REF` (or `CLAUDE_STATUSLINE_RAW_URL` for the status line) so the files the installer downloads come from that commit too:

| Module | Repo | Ref |
|--------|------|-----|
| `skill-commit` | elvisgastelum/claude-commit-skill | `REF` |
| `skill-continue` | elvisgastelum/claude-continue-skill | `REF` |
| `skill-kaneo` | elvisgastelum/kaneo-work-tracking-skill | `REF` |
| `statusline` | elvisgastelum/claude-statusline | `CLAUDE_STATUSLINE_RAW_URL` |
| `herdr-config` | elvisgastelum/herdr-config | none: the script is pinned, but it downloads its files from `main` |

To move the pins to the current default-branch commit of each repo (needs an authenticated `gh`):

```bash
pnpm --filter @claude-curated/catalog bump-installers          # dry run: current -> latest
pnpm --filter @claude-curated/catalog bump-installers --write  # rewrite modules/*/module.json
pnpm test                                                      # then review the diff and commit
```

To add your own, see [packages/catalog/README.md](packages/catalog/README.md).

## Safety

- Writes only inside the target directory. Catalog paths that are absolute or contain `..` are rejected. Only `command` steps (such as `claude mcp add`, `brew install` or an upstream installer) act outside it; `ccc plan` lists each one before you apply.
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
ccc capture                                          # TUI: pick items, review redactions, choose where to write
ccc capture --out ~/code/claude-curated-config/packages/catalog --dry-run          # preview
ccc --cli capture --out ~/code/claude-curated-config/packages/catalog --yes --json # agents, scripts
```

Write into your own clone of this repo, never into the installer's checkout (`~/.local/share/claude-curated-config` or `$CCC_HOME`): a later `ccc` update (`git pull --ff-only`) would conflict with the captured files. Outside the TUI, `--out` is required unless the catalog in use (`--catalog`) is inside a git checkout that is not the installer's; otherwise capture exits `2` (`out_required`). The TUI asks for the directory, defaulting to the catalog of the clone you run it from.

It reads `~/.claude` (`CLAUDE.md`, `settings.json`, the status line script referenced by settings, `skills/*/`, `agents/*.md`, `commands/**/*.md`, `output-styles/*.md`) and the user-scope `mcpServers` from `~/.claude.json`, and writes one module per item into the catalog (`personal-settings`, `personal-claude-md`, `personal-skill-<name>`, `personal-mcp-<name>`, ...) plus a `personal` profile (merged into an existing one: its modules and order stay, new captured modules are appended). Caches and state (`projects/`, `todos/`, `plugins/`, `history*`, logs, `.ccc-backups/`, ...) and dependency or build directories (`node_modules`, `.venv`, `venv`, `dist`, `build`, `target`, `.next`, `.cache`, `coverage`) are ignored. Symlinked directories inside an item are not followed, unreadable entries are skipped, and an item with more than 500 files or 5 MB is skipped whole; every skipped path is reported with its reason; plugins are captured through `enabledPlugins` and `extraKnownMarketplaces` in `settings.json`. MCP servers become `claude mcp add-json --scope user` commands.

Secrets are never written. In JSON (settings, env maps, MCP `args`, `env` and `headers`) and scripts, values under secret-looking keys (`token`, `secret`, `password`, `api_key`, `auth`, `*_KEY`, `DATABASE_URL`, `*_CONNECTION_STRING`, ...) are replaced; markdown and text files only redact unambiguous names (`password:`, `token:`, `api_key:`, ...), so frontmatter such as `author:` stays intact. Everywhere, strings shaped like credentials are replaced: `sk-...` (incl. `sk-ant-`), `ghp_...`, `github_pat_...`, `xox?-...`, `AKIA...`, `npm_...`, `glpat-...`, `AIza...`, `hf_...`, private keys, JWTs, `Bearer` tokens, the password in `scheme://user:password@host`, `token=`/`key=`/`password=` URL parameters, hex strings of 32+ characters (git SHAs included) and long random strings. They become `${CCC_SECRET_<NAME>}` placeholders, and the module declares them under `secrets`; MCP servers keep the placeholder in their `add-json` argument until apply. Values that only reference environment variables (`${GITHUB_TOKEN}`) are kept. Capture prints every redaction (where and which placeholder, never the value).

Capture also keeps infrastructure details out of the catalog: host names under your private domains (`CCC_PRIVATE_DOMAINS`, comma-separated, default: `privateDomains` of the catalog's `capture.config.json`), `*.ts.net` (Tailscale) hosts, `*.local` hosts in a URL, `host:port` or as a whole structured value such as an env value `nas.local` (in prose a bare `foo.local` is treated as a file name), and private IPv4 addresses (10/8, 172.16/12, 192.168/16, 100.64/10) become `${CCC_INPUT_<NAME>}` placeholders. The module declares them as non-secret `inputs`, the capture report lists each one under `privacy` (where and which placeholder, never the value), and apply asks for them like secrets (plain text).

Applying a module with secrets asks for each value in the TUI (masked input); in `--cli` mode it reads the environment variable of the same name and exits `2` (`secrets_missing`, listing the names) when one is missing, before writing anything. `apply --dry-run` needs no values: those steps show as `needs secret <NAME>`. Non-secret module inputs (such as `KANEO_URL`) work the same way, prompted as plain text; a missing one in `--cli` mode exits `2` with `inputs_missing` (dry runs show `needs input <NAME>`). Only steps that will run need their values: a command step's check runs first, so re-applying `personal` where the `kaneo` MCP server is already registered does not ask for `KANEO_URL`. A check that reads a missing value itself blocks its step. A step skipped only because a required binary is missing still asks for its values up front when an earlier module in the same apply installs that binary (it lists it in `providesBins`, as the `tool-*` modules do); otherwise the step is just skipped and its values are not asked for.

Capture skips what the catalog already installs: paths, settings keys, hook commands, MCP servers and managed CLAUDE.md blocks (`<!-- BEGIN name -->`...`<!-- END name -->` or namespaced `<!-- ns:name -->`...`<!-- /ns:name -->` markers such as `gentle-ai:engram`) that a non-personal module `provides` are reported as `skipped` with `provided by <module>`. `skills/synced` (managed by Claude) and `skills/homelab-service-manager` are never captured, and neither is what the catalog's `capture.config.json` lists: settings JSON pointers (`ignoreSettings`, such as `/skipDangerousModePermissionPrompt`) and settings array item patterns (`ignoreSettingsItems`, such as `homelabctl`), reported as `skipped` with reason `ignored by capture config` (see the catalog README). Settings strings with an absolute path in a home directory (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`, or your expanded home directory) are skipped with reason `machine-local path` and never rewritten to `~`; the literal text `$HOME` and `~/` paths are not matched and stay. The captured CLAUDE.md keeps only your own sections and, on apply, keeps the managed blocks installers add.

Re-running capture updates the personal modules in place (unchanged files are not rewritten). Always review the result with `git diff` before committing.

| Flag | Meaning |
|------|---------|
| `--out <dir>` | Catalog directory to write. Required unless the catalog in use is inside a git checkout other than the installer's. |
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
