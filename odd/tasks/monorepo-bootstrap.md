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
Strategy: `single-pr` (user decision 2026-10-11). Create public repo elvisgastelum/claude-curated-config, push `main` + this branch, open one PR after T6–T9 land.

## Tasks
| ID | Task | Route | Status | Commit |
|----|------|-------|--------|--------|
| T1 | Workspace scaffold (root package.json, pnpm-workspace, tsconfig, biome, vitest) | delegated (writer trigger: 2+ files) | [x] | 1ddf457 |
| T2 | Core engine + unit tests | delegated | [x] | a81a65a |
| T3 | Seed catalog modules + profiles | delegated | [x] | 310b190 |
| T4 | CLI: commander `--cli` + JSON + clack TUI + integration test | delegated | [x] | 0c37e61 |
| T5 | install.sh, README, AGENTS.md, CLAUDE.md | delegated | [x] | e441ca7 |
| T6 | Review fixes (recursive deny globs, pin context7, unique backups, dry-run shows blocked, dangling symlinks, per-step errors, atomic writes, installer cleanup, docstring/dup cleanups) | delegated | [x] | 4c8d3d4 |
| T7 | Explicit profile order (`order` field; minimal first) | delegated | [x] | f0a63fe |
| T8 | json-merge conflict detection: TUI asks per conflict; `--cli` fails exit 2 listing conflicts unless `--on-conflict catalog\|keep` or `--resolve <module>:<json.path>=catalog\|keep` | delegated | [x] | e8a257a |
| T9 | `ccc capture`: import current ~/.claude into catalog modules + `personal` profile; secrets redacted to `${VAR}` placeholders filled at apply (TUI prompt / env in agent mode) | delegated | [x] | 5de5a65 |
| T10 | Review 2 fixes on PR #1: broader secret detection (`*_KEY`, `DATABASE_URL`, hex, URL credentials, MCP argv), status honors secrets/keep, bounded+tolerant capture walk, Node >= 20.12 floor, capture requires `--out` when running from the installer checkout, small R2 cleanups | delegated | [ ] | |

Route evidence: empty repo, 5 tasks across many non-trivial files → one bounded writer (mandatory writer trigger).

## Progress / evidence
- Repo initialized on `main` (5e871ad), work on `feat/monorepo-bootstrap`.
- T1: root scaffold. Pinned: typescript 7.0.2, tsup 8.5.1, vitest 5.0.3, @biomejs/biome 2.5.15, @types/node 22.20.5. `pnpm install` needed `allowBuilds: { esbuild: true }` in pnpm-workspace.yaml (pnpm 12 fails on ignored build scripts). `pnpm lint`: ok (4 files). `pnpm build`/`pnpm typecheck`: ok (no packages yet). Test-first exception: scaffold has no behavior.
- T2: core engine. RED observed (22/22 failing against empty index), then GREEN 22/22 (`vitest run --project core`). Covers merge semantics, idempotency, backups, symlinks, dry-run, path-escape rejection, requires ordering + cycles, command check/requiresBin skip with a fake PATH bin, status, doctor. `pnpm typecheck` ok, `pnpm lint` ok. Decisions: scalars from the catalog win in json-merge; backup timestamp replaces `:` with `-` (portable file names); apply re-evaluates each step against disk state; a step that cannot be applied (invalid existing JSON, dest is a directory) is planned as `skip` with `blocked: true` and fails on apply (exit 1).
- T3: seed catalog (core-settings, global-instructions, skill-commit, mcp-context7; profiles minimal/full) + README. RED observed (4/4 failing with an empty catalog), GREEN 4/4: the catalog test loads the real catalog through core, checks profiles, plans `full` against an empty dir (mcp-context7 = skip without `claude` on PATH), and validates the skill frontmatter. Full suite 26/26, typecheck and lint ok.
- T4: CLI (commander 14.0.3, @clack/prompts 1.8.1, picocolors 1.1.1; tsup bundles core, catalog external, shebang banner). RED observed (11/11 failing against a stub bin), GREEN 11/11 integration tests running `node dist/index.js` with piped stdio and a PATH without the real `claude` (version, list, no-subcommand help/JSON, plan shape, apply minimal + idempotent, dry-run, non-TTY apply without --yes = exit 2 ccc.error/v1, unknown module = exit 3, usage errors = exit 2, status/doctor, command step via a fake `claude`). Full suite 37/37. TUI smoke-tested in a pseudo-TTY (`script`) against a temp dir: profile pick, plan note, confirm, per-module spinner, outro; Ctrl+C at the first prompt exits 130. Deviation: commander 15 requires Node >= 22.12, so 14.0.3 (Node >= 20) is pinned.
- T5: install.sh + README.md + AGENTS.md + CLAUDE.md (`@AGENTS.md`). Test-first exception: shell installer and docs have no runnable RED; checked functionally instead. `bash -n install.sh`: ok; shellcheck not installed (skipped). Installer exercised end-to-end with `CCC_REPO=<local checkout> CCC_REF=feat/monorepo-bootstrap CCC_HOME/CCC_BIN_DIR=<tmp>` piped through `bash -s -- --cli apply --profile minimal --yes --json --claude-dir <tmp>`: exit 0, stdout is a clean `ccc.apply/v1` doc (installer logs on stderr), wrapper written; re-run with `CCC_NO_RUN=1` updates via `git pull --ff-only`; missing node prints a fix hint and exits 1. Additions beyond the design: `CCC_BIN_DIR`, `CCC_NO_RUN`, `corepack pnpm` fallback when `corepack enable` lacks permissions, colors only on a TTY.
- Final verification: pnpm install 0, pnpm build 0, pnpm typecheck 0, pnpm lint 0, pnpm test 0 (37/37), manual apply minimal twice into $TMPDIR/ccc-check (done 2, then unchanged 2, exit 0 both), non-TTY apply without --yes exit 2.

- Parent spot check: `pnpm test` → 37/37 passed. `.atl/` (local skill registry) added to `.gitignore` (chore commit) so the review candidate has no untracked files.
- Native review (RDD on, risk high: install.sh executable + shell process): standing consent granted, four lenses, **approved**, acknowledged (lineage review-ebece59909012874, authority burned). No blocking findings.

- T6: RED observed (4 new core tests failing: backup collision, dry-run blocked, dangling symlink, per-step error), GREEN 43/43. Core: `fsutil.ts` (atomic temp+rename writes keeping the file mode, atomic symlink swap, lazy unique backup dir `<stamp>`, `<stamp>-1`, ... with `COPYFILE_EXCL` and numeric suffixes, symlinks backed up as symlinks); `startApply()` run object (TUI uses it so one run shares one backup dir) and `apply()` wrapper; evaluate errors become blocked steps; a failed step skips the rest of its module and transitive dependents (`PlannedModule.requires` added); dry-run reports blocked as `failed` and missing-bin as `skipped`. json-merge through a live symlink writes the real file (dotfiles), dangling links are replaced. `MIN_NODE_MAJOR` derives from root `engines.node`; install.sh reads the same value from the checkout. CLI test global setup always rebuilds dist. Catalog: `**/` deny globs, `@upstash/context7-mcp@4.3.0`. install.sh exercised in temp dirs with a fake failing `pnpm build`: fresh install exit 1 + checkout removed; fresh ok exit 0; update failing once -> reset to previous HEAD, rebuilt, exit 1 with "previous version is still installed", wrapper `--version` works.

- T7: RED observed (4 failing: core order sort + validation, seed catalog order, CLI list order), GREEN 46/46. `Profile.order?: number` validated in the loader; `loadCatalog` sorts profiles by order (missing = last), then id, so `list`, `list --json` and the TUI share one order. `minimal` 10, `full` 20.

- T8: RED observed (7 failing: findConflicts pointers/type change, plan conflicts + apply refusal, keep idempotent, catalog policy + explicit override, CLI exit 2 + resolved apply, malformed --resolve), GREEN 53/53. Paths are RFC 6901 JSON pointers; keys `<module>:<pointer>`. `Plan.conflicts` (+ `resolutions`, `onConflict` carried so apply re-evaluates with the same decisions); core refuses a step with undecided conflicts (`failed`). CLI: `--on-conflict`, repeatable `--resolve` (validated, exit 2 `invalid_resolve`), `ccc.error/v1` `conflicts_unresolved` with `error.conflicts[].flags` shell-quoted; `plan --json` always has `conflicts`. TUI and interactive `ccc apply` prompt per conflict with all-remaining shortcuts. Decisions are not persisted (open question).

- T9: core RED observed (8 failing: findSecrets, scan, include filter, write + redaction, idempotent/prune, dry-run, apply substitution, command args), GREEN; CLI capture tests were written after the CLI wiring (no separate RED), GREEN 63/63. Core `secrets.ts` (key-name + shape + entropy>4 detection, `Redactor` with deterministic `CCC_SECRET_<PREFIX>_<KEY>` names, auth scheme kept, env refs kept, argv `--flag value`/`KEY=value`), `capture.ts` (`captureClaudeConfig` + idempotent `writeCapture` with stale-file pruning and `profiles/personal.json` order 30). Engine: module `secrets`, `plan({ secrets })` substitutes in json-merge sources, text files and command args, missing value = blocked step, plan keeps values non-enumerable, messages and conflict values masked; copied files keep the source mode. CLI: `ccc capture` (`ccc.capture/v1`, exit 2 without --yes, TUI groupMultiselect + redaction note + confirm), `secrets_missing` exit 2, `plan --json` `secrets[].provided`, TUI/interactive apply prompt with masked `password`. TTY smoke (expect, temp HOME): capture TUI wrote 3 modules, apply prompted for the secret, value absent from the log.

- T6-T9 final verification: pnpm install 0, pnpm build 0, pnpm typecheck 0, pnpm lint 0 (49 files), pnpm test 0 (63/63), bash -n install.sh 0. Manual (temp HOME/dirs only, no real claude): apply minimal twice -> done,done then unchanged,unchanged (backupDir null); conflicting `$schema` -> exit 2 `conflicts_unresolved` with `--resolve 'core-settings:/$schema=keep'`, only settings.json present; `--on-conflict keep` -> exit 0, user `$schema` kept; capture of a fixture dir + fixture claude.json -> 3 modules, 3 redactions, `grep -r` of the fake secret in output and JSON = 0 matches.
- Open questions: persist conflict decisions between runs?; `--out` default for the installed `ccc` is the installer checkout (a later `git pull --ff-only` update may then refuse); absolute statusLine paths are only warned about, not rewritten.

## Follow-ups (advisory review findings → scheduled as T6/T7)
- R1: `core-settings` deny rules are `./`-anchored; use `**/.env`, `**/.env.*`, `**/secrets/**`.
- R1: pin `@upstash/context7-mcp` version in `mcp-context7`.
- R3: backups can collide on the same timestamp; dry-run hides `blocked` steps; an evaluate throw aborts the whole apply; blocked path untested; CLI tests may run a stale `dist`.
- R4: dangling symlink at dest crashes evaluate; settings writes are not atomic (write temp + rename); installer has no rollback on failed build; apply abort loses the partial report.
- R2: backup docstring says "moved" vs copied; duplicated min-node constant and pending-count logic.
- Product: explicit profile order (minimal first in TUI); decide json-merge conflict rule (catalog wins vs keep user value); `ccc capture` to import the current `~/.claude` into the catalog.

## Review 2 (T6–T9, base 7bbfb7e)
- Parent spot check: `pnpm test` → 63/63. Native review risk high → standing consent, four lenses, **approved**, acknowledged (lineage review-690cdbf172f3070f, authority burned). No blocking findings.
- Advisory follow-ups (do before running `ccc capture` on the real config into this public repo):
  - R1: secret detection misses `*_KEY` names (e.g. `OPENAI_KEY`), `DATABASE_URL`, long hex tokens; MCP secrets can end up in argv.
  - R4/R3: `status` ignores provided secrets and `keep` resolutions (misreports modules); capture walk follows symlinks unbounded and is not error-tolerant; `Dirent.parentPath` needs Node >= 20.12 (raise `engines.node` or avoid it).
  - R2: personal profile action misreported on empty capture; duplicated apply flow / truncate helpers; dry-run requires secrets.
- Pre-push history scan: no real credentials (only regex sources, docs and fake fixtures).

## Next step
PR #1 open (https://github.com/elvisgastelum/claude-curated-config/pull/1). User decisions 2026-10-11: fix review 2 gaps on PR #1 (T10); do NOT remember keep decisions between runs; installed `ccc capture` requires `--out`; then run `ccc capture --dry-run` on the real ~/.claude and show items + redactions before writing anything.
