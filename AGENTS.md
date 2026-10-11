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
#    when unspecified, and ask before choosing `full` or `personal`.
ccc --cli plan --profile minimal --json

# 3. Apply (add --resolve / --on-conflict flags when the plan has conflicts, see below).
ccc --cli apply --profile minimal --yes --json
```

### Profiles that install tools (`personal`, `full`)

These profiles run upstream installers (`curl ... | bash`, `brew install`, `npm install -g`, `npx`, `gentle-ai install`, `engram setup`, `codegraph install`, `herdr integration install`). Before applying:

1. Run `ccc --cli plan --profile personal --json` and show the human every step with `action: "run"`: its module and `command` (for `shell` steps, `command` is `["bash", "-c", "<script>"]`). Say which ones install software (`tool-*`) and which write outside the Claude dir (`herdr-config`).
2. Apply only after the human agrees: `ccc --cli apply --profile personal --yes --json`.
3. Report `skipped` steps with their reason: a missing `brew`/`npm`/`curl` (`"<bin>" not found on PATH`), another OS (`runs only on darwin, linux`), or a tool that can only configure `~/.claude` while `--claude-dir` points elsewhere (`configures ~/.claude only`). Do not install the missing prerequisite yourself without asking.

Installers run with stdin closed, so they never wait for input. Re-runs are idempotent: each step has a check and runs only when its target is missing.

### Settings conflicts

A `json-merge` step (e.g. `settings.json`) conflicts when the user's file already has a value at a path where the catalog has a different one. Arrays never conflict (they are unioned) and new keys are simply added. `apply` never overwrites a conflicting value without a decision:

1. Read `conflicts` from `ccc --cli plan ... --json`. Each entry has `module`, `step`, `dest`, `path` (a JSON pointer), `current`, `catalog` and, when decided, `resolution`.
2. If there are conflicts, show the human each `path` with its `current` and `catalog` values and ask which to use, unless they already told you (e.g. "keep my settings" means `keep`). Do not decide on their behalf.
3. Re-run with the decisions: `--resolve <module>:<path>=catalog|keep` per conflict (repeatable; quote it, pointers can contain `$`), or `--on-conflict catalog|keep` for all of them. An explicit `--resolve` wins over `--on-conflict`.

Without decisions, a non-interactive `apply` (including `--dry-run`) exits `2` with `ccc.error/v1` code `conflicts_unresolved`, writes nothing, and lists every conflict with the exact `--resolve` flags in `error.conflicts[].flags`. Decisions are not remembered: pass them again on later runs (`--on-conflict keep` keeps re-runs idempotent).

If `ccc` is not on `PATH` after step 1, call `~/.local/bin/ccc`.

Rules:

- Only use profile and module ids printed by `ccc --cli list --json`. Never invent ids.
- Preview with `plan` before `apply`. If the plan contains `update` steps, tell the user which files will be replaced (they are backed up).
- Pass `--claude-dir <path>` only when the user names a different target; the default is `$CLAUDE_CONFIG_DIR` or `~/.claude`.
- Do not edit files under `~/.claude` by hand to "help" the tool; re-run it instead.
- Report the result: modules applied, steps per status, the `backupDir` if any, and any `skipped` or `failed` step with its `message`.

### Secrets

Modules may declare `secrets` (`CCC_SECRET_*` names). `ccc --cli plan --json` lists them under `secrets` with `provided`; `apply --dry-run` works without them (those steps are `planned` with message `needs secret <NAME>`). `apply` reads each from the environment variable of the same name; if any is missing it exits `2` with `ccc.error/v1` code `secrets_missing` and `error.secrets: [{ name, description, module }]`, writing nothing. Ask the human to export the values (or run `ccc` in a terminal, which prompts with masked input). Never print, log or commit secret values.

Modules may also declare non-secret `inputs` (`{ name, description }`, e.g. `KANEO_URL`, or `CCC_INPUT_*` placeholders from a capture's privacy scan). They are listed in `plan --json` `secrets` with `secret: false`, read from the environment variable of the same name, and prompted as plain text in a terminal. When only inputs are missing, `apply` exits `2` with code `inputs_missing` and `error.inputs: [{ name, description, module }]` (`secrets_missing` errors carry both `error.secrets` and `error.inputs`). Ask the human for the values; do not guess them. Only values that a step which will run needs are required: command checks run first, so a satisfied step (for example an already registered MCP server) needs none, and `plan --json` marks each entry `needed: true|false`. A step skipped only because a `requiresBin` is missing still needs its values, because an earlier module may install the bin before apply reaches it.

## Capture a machine's setup into the catalog

Use when asked to "save/capture my Claude setup" into this repo.

```sh
ccc --cli capture --out <repo>/packages/catalog --dry-run --json   # 1. preview
ccc --cli capture --out <repo>/packages/catalog --yes --json       # 2. write modules + profiles/personal.json
git -C <repo> diff --stat && git -C <repo> diff   # 3. review
```

Rules:

- Capture skips whatever the catalog's installer modules `provide` (reported in `skipped` as `provided by <module>`), plus `skills/synced` and `skills/homelab-service-manager`, and what the catalog's `capture.config.json` lists (read from the `--out` catalog, else the catalog in use): `ignoreSettings` JSON pointers such as `/skipDangerousModePermissionPrompt` and `ignoreSettingsItems` patterns such as `homelabctl`, both reported with reason `ignored by capture config`. Do not hand-copy any of those items into personal modules. An invalid `capture.config.json` exits `3` (`invalid_capture_config`).
- Pass `--out <your clone>/packages/catalog` so the modules land in the git checkout you will commit from. Without `--out`, capture exits `2` (`ccc.error/v1` code `out_required`) when the catalog in use is the installer's checkout (`$CCC_HOME`, default `~/.local/share/claude-curated-config`) or is not inside a git checkout.
- `privacy` lists private infrastructure that was replaced with `${CCC_INPUT_*}` placeholders (declared as module `inputs`): host names under the domains in `CCC_PRIVATE_DOMAINS` (comma-separated; default: `privateDomains` of `capture.config.json`), `*.ts.net` hosts, `*.local` hosts in a URL, `host:port`, or as a whole structured value (a JSON setting, env value, header or argv item such as `nas.local`; in prose a bare `foo.local` is treated as a file name), and private IPv4 addresses (10/8, 172.16/12, 192.168/16, 100.64/10). Set `CCC_PRIVATE_DOMAINS` to your own domains before capturing.
- Before committing, show the human the `redactions` and `privacy` lists (module, location, placeholder) and the `git diff`, and get their go-ahead. If you spot a secret that was not redacted, stop and tell them; do not commit it.
- Output is `ccc.capture/v1`: `{ claudeDir, claudeJson, outDir, dryRun, items: [{ id, kind, source, action, files, secrets, inputs }], redactions: [{ module, location, placeholder }], privacy: [{ module, location, placeholder }], skipped: [{ path, reason }], warnings, profile: { id, path, action, modules } }`. It never contains secret values.
- Without `--yes` (and without `--dry-run`) a non-interactive capture exits `2` (`confirmation_required`).
- `warnings` starts with any catalog whose `provides` could not be loaded (`provides of the catalog <dir> not loaded (...)`): items its modules install may then be captured again, so fix that catalog first.
- An existing `profiles/personal.json` that is not valid JSON or has no `modules` list is never overwritten: capture exits `3` (`ccc.error/v1` code `invalid_profile`, "fix or remove it") and writes nothing.

### Exit codes

| Code | Meaning | What to do |
|------|---------|------------|
| 0 | Success | Report the result. |
| 1 | A step failed (or is blocked, also under `--dry-run`), or `doctor` found a required check failing | Read `message` on failed steps (or `fix` on failed checks), report, do not retry blindly. |
| 2 | Usage error or refusal (e.g. `apply` without `--yes`, or unresolved settings conflicts) | Fix the arguments; for `conflicts_unresolved`, ask the human and pass `--resolve`/`--on-conflict`. |
| 3 | Catalog or validation error (unknown module or profile) | Run `list`, use a real id. |

### JSON documents

Every document has a `schema` field.

- `ccc.doctor/v1`: `{ ok, checks: [{ id, ok, required, message, fix? }] }`. `ok` is false only if a `required` check fails. A missing `claude` CLI is a warning: `command` steps are skipped until it is installed. Installer prerequisites (`bash`, `curl`, `jq`, `npm`, `npx`, `brew`) are optional checks.
- `ccc.list/v1`: `{ catalogDir, modules: [{ id, name, description, tags, requires, steps }], profiles: [{ id, name, description, order?, modules }] }`. Profiles are sorted by `order` (lower first), then id.
- `ccc.plan/v1`: `{ claudeDir, selection, summary: { create, update, unchanged, run, skip }, modules: [{ id, name, steps: [{ index, type, action, reason, summary, dest?, command?, blocked }] }], conflicts: [{ module, step, dest, path, current, catalog, resolution? }] }`. Modules are in apply order (required modules first).
- `ccc.apply/v1`: `{ claudeDir, selection, dryRun, ok, backupDir, summary: { done, unchanged, skipped, failed, planned }, modules: [{ id, name, ok, steps: [{ index, type, action, status, message, dest?, command?, backup? }] }] }`.
- `ccc.status/v1`: `{ claudeDir, modules: [{ id, name, state: "applied" | "partial" | "not-applied" | "conflicts" | "needs-secrets", satisfied, pending, skipped, conflicts, missingSecrets }] }`. `conflicts`: only undecided settings conflicts differ (pass the same `--resolve`/`--on-conflict` as for `apply`); `needs-secrets`: export the `missingSecrets` env vars to check it. Nothing is remembered between runs.
- `ccc.error/v1`: `{ error: { code, message, ...details }, exitCode }`. `conflicts_unresolved` adds `error.conflicts` (the plan conflicts plus `flags: { catalog, keep }`).

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
