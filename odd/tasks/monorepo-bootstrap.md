# Feature: monorepo-bootstrap

## Objective
A pnpm monorepo that configures Claude Code (`~/.claude`) on any machine from a curated catalog, usable by:
- humans: a polished TUI (default when a TTY is attached) and a `curl | bash` one-liner installer;
- agents: a non-interactive `--cli` mode with `--json` output, `--yes`, `--dry-run`, stable exit codes, and an `AGENTS.md` so "set up this machine with claude-curated-config" is enough.

## Problem / why
Setting up Claude Code on a new machine is manual (settings, CLAUDE.md, skills, agents, MCP servers, plugins). One declarative catalog + one idempotent engine removes the drift.

## Scope
- `packages/core` (`@claude-curated/core`): catalog loading/validation, plan, apply, status, doctor, backups. Step types: `file` (copy|symlink), `json-merge`, `command` (with `check`).
- `packages/catalog` (`@claude-curated/catalog`): curated modules + profiles (plain data, no build).
- `packages/cli` (`@claude-curated/cli`): bin `ccc` / `claude-curated`; TUI via @clack/prompts, CLI via commander.
- `install.sh` one-liner, `README.md`, `AGENTS.md`, `CLAUDE.md`.

## Constraints
- Node >= 20, pnpm via corepack, TypeScript ESM, vitest, biome.
- Never write outside the target Claude dir (`--claude-dir`, `$CLAUDE_CONFIG_DIR`, or `~/.claude`) except `command` steps.
- Every write backs up the previous file to `<claude-dir>/.ccc-backups/<timestamp>/`.
- Idempotent: re-applying a satisfied plan changes nothing.
- No secrets in the catalog.

## Acceptance criteria
- `pnpm install && pnpm build && pnpm test && pnpm lint` pass.
- `ccc --cli apply --profile minimal --yes --json --claude-dir <tmp>` writes files and returns a `ccc.apply/v1` JSON envelope; a second run reports no changes.
- Non-TTY without `--yes` refuses `apply` with exit code 2.
- `ccc` in a TTY opens the TUI (profile/module pick → plan → confirm → apply).
- `install.sh` clones/updates, builds, links `~/.local/bin/ccc`, forwards args.

## Delivery
Strategy: `ask-on-risk`. Forecast ~1500 authored lines (exceeds 400 → chain strategy to be asked before PRs). Push/PR are user decisions.

## Tasks
| ID | Task | Route | Status | Commit |
|----|------|-------|--------|--------|
| T1 | Workspace scaffold (root package.json, pnpm-workspace, tsconfig, biome, vitest) | delegated (writer trigger: 2+ files) | [x] | 1ddf457 |
| T2 | Core engine + unit tests | delegated | [x] | a81a65a |
| T3 | Seed catalog modules + profiles | delegated | [x] | 310b190 |
| T4 | CLI: commander `--cli` + JSON + clack TUI + integration test | delegated | [x] | 0c37e61 |
| T5 | install.sh, README, AGENTS.md, CLAUDE.md | delegated | [x] | e441ca7 |

Route evidence: empty repo, 5 tasks across many non-trivial files → one bounded writer (mandatory writer trigger).

## Progress / evidence
- Repo initialized on `main` (5e871ad), work on `feat/monorepo-bootstrap`.
- T1: root scaffold. Pinned: typescript 7.0.2, tsup 8.5.1, vitest 5.0.3, @biomejs/biome 2.5.15, @types/node 22.20.5. `pnpm install` needed `allowBuilds: { esbuild: true }` in pnpm-workspace.yaml (pnpm 12 fails on ignored build scripts). `pnpm lint`: ok (4 files). `pnpm build`/`pnpm typecheck`: ok (no packages yet). Test-first exception: scaffold has no behavior.
- T2: core engine. RED observed (22/22 failing against empty index), then GREEN 22/22 (`vitest run --project core`). Covers merge semantics, idempotency, backups, symlinks, dry-run, path-escape rejection, requires ordering + cycles, command check/requiresBin skip with a fake PATH bin, status, doctor. `pnpm typecheck` ok, `pnpm lint` ok. Decisions: scalars from the catalog win in json-merge; backup timestamp replaces `:` with `-` (portable file names); apply re-evaluates each step against disk state; a step that cannot be applied (invalid existing JSON, dest is a directory) is planned as `skip` with `blocked: true` and fails on apply (exit 1).
- T3: seed catalog (core-settings, global-instructions, skill-commit, mcp-context7; profiles minimal/full) + README. RED observed (4/4 failing with an empty catalog), GREEN 4/4: the catalog test loads the real catalog through core, checks profiles, plans `full` against an empty dir (mcp-context7 = skip without `claude` on PATH), and validates the skill frontmatter. Full suite 26/26, typecheck and lint ok.
- T4: CLI (commander 14.0.3, @clack/prompts 1.8.1, picocolors 1.1.1; tsup bundles core, catalog external, shebang banner). RED observed (11/11 failing against a stub bin), GREEN 11/11 integration tests running `node dist/index.js` with piped stdio and a PATH without the real `claude` (version, list, no-subcommand help/JSON, plan shape, apply minimal + idempotent, dry-run, non-TTY apply without --yes = exit 2 ccc.error/v1, unknown module = exit 3, usage errors = exit 2, status/doctor, command step via a fake `claude`). Full suite 37/37. TUI smoke-tested in a pseudo-TTY (`script`) against a temp dir: profile pick, plan note, confirm, per-module spinner, outro; Ctrl+C at the first prompt exits 130. Deviation: commander 15 requires Node >= 22.12, so 14.0.3 (Node >= 20) is pinned.
- T5: install.sh + README.md + AGENTS.md + CLAUDE.md (`@AGENTS.md`). Test-first exception: shell installer and docs have no runnable RED; checked functionally instead. `bash -n install.sh`: ok; shellcheck not installed (skipped). Installer exercised end-to-end with `CCC_REPO=<local checkout> CCC_REF=feat/monorepo-bootstrap CCC_HOME/CCC_BIN_DIR=<tmp>` piped through `bash -s -- --cli apply --profile minimal --yes --json --claude-dir <tmp>`: exit 0, stdout is a clean `ccc.apply/v1` doc (installer logs on stderr), wrapper written; re-run with `CCC_NO_RUN=1` updates via `git pull --ff-only`; missing node prints a fix hint and exits 1. Additions beyond the design: `CCC_BIN_DIR`, `CCC_NO_RUN`, `corepack pnpm` fallback when `corepack enable` lacks permissions, colors only on a TTY.
- Final verification: pnpm install 0, pnpm build 0, pnpm typecheck 0, pnpm lint 0, pnpm test 0 (37/37), manual apply minimal twice into $TMPDIR/ccc-check (done 2, then unchanged 2, exit 0 both), non-TTY apply without --yes exit 2.

## Next step
All tasks done on `feat/monorepo-bootstrap`. Forecast exceeded ~400 lines: ask for the chain strategy (`stacked-to-main` or `feature-branch-chain`) before opening PRs. Push/PR are user decisions.
