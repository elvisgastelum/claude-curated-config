# AGENTS.md

Two audiences read this file: agents asked to set up a machine with this repo, and agents developing the repo itself.

## Set up a machine

Use when asked something like "set up this machine with github.com/elvisgastelum/claude-curated-config".

Always pass `--cli --json`. Installer logs go to stderr; stdout carries exactly one JSON document.

```sh
URL=https://raw.githubusercontent.com/elvisgastelum/claude-curated-config/main/install.sh

# 1. Install or update, then check prerequisites.
curl -fsSL "$URL" | bash -s -- --cli doctor --json

# 2. Preview. Use the profile or modules the user asked for; default to `minimal`
#    when unspecified, and ask before choosing `full`.
ccc --cli plan --profile minimal --json

# 3. Apply.
ccc --cli apply --profile minimal --yes --json
```

If `ccc` is not on `PATH` after step 1, call `~/.local/bin/ccc`.

Rules:

- Only use profile and module ids printed by `ccc --cli list --json`. Never invent ids.
- Preview with `plan` before `apply`. If the plan contains `update` steps, tell the user which files will be replaced (they are backed up).
- Pass `--claude-dir <path>` only when the user names a different target; the default is `$CLAUDE_CONFIG_DIR` or `~/.claude`.
- Do not edit files under `~/.claude` by hand to "help" the tool; re-run it instead.
- Report the result: modules applied, steps per status, the `backupDir` if any, and any `skipped` or `failed` step with its `message`.

### Exit codes

| Code | Meaning | What to do |
|------|---------|------------|
| 0 | Success | Report the result. |
| 1 | A step failed (or is blocked, also under `--dry-run`), or `doctor` found a required check failing | Read `message` on failed steps (or `fix` on failed checks), report, do not retry blindly. |
| 2 | Usage error or refusal (e.g. `apply` without `--yes`) | Fix the arguments. |
| 3 | Catalog or validation error (unknown module or profile) | Run `list`, use a real id. |

### JSON documents

Every document has a `schema` field.

- `ccc.doctor/v1`: `{ ok, checks: [{ id, ok, required, message, fix? }] }`. `ok` is false only if a `required` check fails. A missing `claude` CLI is a warning: `command` steps are skipped until it is installed.
- `ccc.list/v1`: `{ catalogDir, modules: [{ id, name, description, tags, requires, steps }], profiles: [{ id, name, description, modules }] }`.
- `ccc.plan/v1`: `{ claudeDir, selection, summary: { create, update, unchanged, run, skip }, modules: [{ id, name, steps: [{ index, type, action, reason, summary, dest?, command?, blocked }] }] }`. Modules are in apply order (required modules first).
- `ccc.apply/v1`: `{ claudeDir, selection, dryRun, ok, backupDir, summary: { done, unchanged, skipped, failed, planned }, modules: [{ id, name, ok, steps: [{ index, type, action, status, message, dest?, command?, backup? }] }] }`.
- `ccc.status/v1`: `{ claudeDir, modules: [{ id, name, state: "applied" | "partial" | "not-applied", satisfied, pending, skipped }] }`.
- `ccc.error/v1`: `{ error: { code, message }, exitCode }`.

Plan actions: `create` (new file), `update` (existing file changes, backed up first), `unchanged`, `run` (a command will run), `skip` (e.g. a required binary is missing; `blocked: true` means it cannot be applied and `apply`, including `--dry-run`, reports it as `failed`). A failed step never aborts the run: later steps of the same module and modules that require it are `skipped` with a message naming the failure, other modules still apply, and the full report is printed.

## Develop this repo

### Layout

```
packages/core      @claude-curated/core     catalog loader, plan/apply/status/doctor (TypeScript, bundled into the CLI)
packages/catalog   @claude-curated/catalog  plain-data modules and profiles + index.js exporting catalogDir
packages/cli       @claude-curated/cli      `ccc` bin: commander CLI + @clack/prompts TUI, built with tsup
install.sh                                  curl | bash installer
odd/tasks/                                  feature task documents
```

### Commands

```sh
pnpm install
pnpm build       # tsup -> packages/cli/dist/index.js
pnpm test        # builds, then vitest (core unit, catalog validation, cli integration)
pnpm lint        # biome check; `pnpm format` to fix
pnpm typecheck   # tsc --noEmit per package
pnpm dev         # tsup --watch for the CLI
```

### Conventions

- TypeScript ESM, strict mode. The minimum Node version has one source: `engines.node` in the root `package.json` (read by `doctor` and `install.sh`; keep `packages/cli/package.json` equal, a test checks it). Biome formats and lints; run `pnpm format` before committing.
- Tests first for behavior changes. Core tests use temp dirs; CLI integration tests run the built bin with a temp `--claude-dir`.
- Never touch the real `~/.claude` in tests or manual checks; always pass a temp `--claude-dir`. Tests must not run the real `claude` binary: use a fake executable on `PATH` or assert `skip`.
- The CLI keeps `@claude-curated/catalog` external so `catalogDir` resolves to the real data directory; core is bundled.
- `--json` output is a public contract. Changing a document's shape requires a new schema version (`/v2`).
- Commit messages: a single Conventional Commit title line, no body, no trailers, no AI attribution.
- Adding catalog content: see `packages/catalog/README.md`. No secrets in the catalog.
