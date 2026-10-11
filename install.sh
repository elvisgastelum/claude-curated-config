#!/usr/bin/env bash
# claude-curated-config installer.
#
# Humans:  curl -fsSL https://raw.githubusercontent.com/elvisgastelum/claude-curated-config/main/install.sh | bash
# Agents:  curl -fsSL https://raw.githubusercontent.com/elvisgastelum/claude-curated-config/main/install.sh \
#            | bash -s -- --cli apply --profile full --yes --json
#
# Environment:
#   CCC_HOME     checkout location   (default: $HOME/.local/share/claude-curated-config)
#   CCC_REPO     git URL to clone    (default: https://github.com/elvisgastelum/claude-curated-config.git)
#   CCC_REF      branch or tag       (default: main)
#   CCC_BIN_DIR  wrapper location    (default: $HOME/.local/bin)
#   CCC_NO_RUN   set to 1 to install/update without running ccc afterwards
#
# All installer output goes to stderr so `--json` output on stdout stays machine-readable.

set -euo pipefail

# Everything lives in main() so bash has read the whole script before any command runs;
# this matters under `curl | bash`, where the script itself arrives on stdin.
main() {
  local repo="${CCC_REPO:-https://github.com/elvisgastelum/claude-curated-config.git}"
  local ref="${CCC_REF:-main}"
  local home_dir="${CCC_HOME:-$HOME/.local/share/claude-curated-config}"
  local bin_dir="${CCC_BIN_DIR:-$HOME/.local/bin}"
  local min_node=20

  local c_info="" c_warn="" c_err="" c_off=""
  if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
    c_info=$'\033[1;36m' c_warn=$'\033[1;33m' c_err=$'\033[1;31m' c_off=$'\033[0m'
  fi
  say() { printf '%s==>%s %s\n' "$c_info" "$c_off" "$*" >&2; }
  warn() { printf '%swarning:%s %s\n' "$c_warn" "$c_off" "$*" >&2; }
  die() {
    printf '%serror:%s %s\n' "$c_err" "$c_off" "$1" >&2
    [ -n "${2:-}" ] && printf '  fix: %s\n' "$2" >&2
    exit 1
  }

  command -v git >/dev/null 2>&1 ||
    die "git is required but was not found." "install git: https://git-scm.com/downloads"
  command -v node >/dev/null 2>&1 ||
    die "Node.js >= ${min_node} is required but was not found." \
      "install Node.js ${min_node}+ (https://nodejs.org, nvm, fnm or your package manager), then re-run."
  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge "$min_node" ] ||
    die "Node.js >= ${min_node} is required (found $(node --version))." \
      "upgrade Node.js (e.g. 'nvm install 22'), then re-run."

  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  local -a pnpm_cmd
  if command -v corepack >/dev/null 2>&1 && corepack enable >/dev/null 2>&1 &&
    command -v pnpm >/dev/null 2>&1; then
    pnpm_cmd=(pnpm)
  elif command -v corepack >/dev/null 2>&1; then
    # `corepack enable` can fail without write access to node's bin dir; corepack still works.
    pnpm_cmd=(corepack pnpm)
  elif command -v pnpm >/dev/null 2>&1; then
    pnpm_cmd=(pnpm)
  else
    die "pnpm is required and corepack is unavailable." \
      "run 'npm install -g corepack && corepack enable' or 'npm install -g pnpm', then re-run."
  fi

  if [ -d "$home_dir/.git" ]; then
    say "Updating $home_dir ($ref)"
    git -C "$home_dir" pull --ff-only --quiet origin "$ref" </dev/null >&2
  else
    say "Cloning $repo ($ref) into $home_dir"
    mkdir -p "$(dirname "$home_dir")"
    git clone --quiet --branch "$ref" "$repo" "$home_dir" </dev/null >&2
  fi

  say "Installing dependencies"
  (cd "$home_dir" && "${pnpm_cmd[@]}" install --frozen-lockfile </dev/null >&2)
  say "Building"
  (cd "$home_dir" && "${pnpm_cmd[@]}" build </dev/null >&2)

  local entry="$home_dir/packages/cli/dist/index.js"
  [ -f "$entry" ] || die "build did not produce $entry" "run 'pnpm build' in $home_dir and check the output."

  mkdir -p "$bin_dir"
  printf '#!/bin/sh\nexec node "%s" "$@"\n' "$entry" >"$bin_dir/ccc"
  chmod +x "$bin_dir/ccc"
  say "Installed $bin_dir/ccc"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) warn "$bin_dir is not on your PATH; add: export PATH=\"$bin_dir:\$PATH\"" ;;
  esac

  if [ "${CCC_NO_RUN:-0}" = "1" ]; then
    return 0
  fi
  # With no arguments, start the TUI. Under `curl | bash` stdin is the pipe, so
  # reattach it to the terminal when one is available.
  if [ "$#" -eq 0 ] && [ ! -t 0 ] && (: </dev/tty) 2>/dev/null; then
    exec node "$entry" </dev/tty
  fi
  exec node "$entry" "$@"
}

main "$@"
