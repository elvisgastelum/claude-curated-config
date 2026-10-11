#!/usr/bin/env node
// Bumps the commit SHAs that pin remote installers in catalog modules to the current HEAD of
// each repo's default branch (read with `gh api`). Dry by default: prints what would change.
//
//   node scripts/bump-installers.mjs           # show current pins and the latest commits
//   node scripts/bump-installers.mjs --write   # rewrite modules/*/module.json
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PIN = /raw\.githubusercontent\.com\/([\w.-]+)\/([\w.-]+)\/([0-9a-f]{40})/g;

/**
 * Finds `raw.githubusercontent.com/<owner>/<repo>/<sha>` pins in `text` and replaces the SHA
 * of every repo in `latest` (also in `"REF": "<old sha>"` values).
 * @param {string} text
 * @param {Record<string, string>} latest repo name -> new SHA
 * @returns {{ text: string, pins: { repo: string, sha: string }[] }}
 */
export function rewritePins(text, latest) {
  /** @type {{ repo: string, sha: string }[]} */
  const pins = [];
  for (const match of text.matchAll(PIN)) {
    const repo = match[2] ?? "";
    const sha = match[3] ?? "";
    if (!pins.some((pin) => pin.repo === repo && pin.sha === sha)) pins.push({ repo, sha });
  }
  let out = text.replace(PIN, (whole, owner, repo, sha) => {
    const next = latest[repo];
    return next && next !== sha ? `raw.githubusercontent.com/${owner}/${repo}/${next}` : whole;
  });
  for (const { repo, sha } of pins) {
    const next = latest[repo];
    if (next && next !== sha)
      out = out
        .replaceAll(`"REF":"${sha}"`, `"REF":"${next}"`)
        .replaceAll(`"REF": "${sha}"`, `"REF": "${next}"`);
  }
  return { text: out, pins };
}

/** @param {string} owner @param {string} repo */
function headOf(owner, repo) {
  return execFileSync("gh", ["api", `repos/${owner}/${repo}/commits/HEAD`, "--jq", ".sha"], {
    encoding: "utf8",
  }).trim();
}

function main() {
  const write = process.argv.includes("--write");
  const modules = join(fileURLToPath(new URL("..", import.meta.url)), "modules");
  const files = readdirSync(modules).map((id) => join(modules, id, "module.json"));
  /** @type {Record<string, string>} */
  const latest = {};
  let changed = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(PIN)) {
      const [, owner = "", repo = ""] = match;
      latest[repo] ??= headOf(owner, repo);
    }
    const result = rewritePins(text, latest);
    for (const pin of result.pins) {
      const next = latest[pin.repo];
      console.log(`${pin.repo}: ${pin.sha}${next !== pin.sha ? ` -> ${next}` : " (current)"}`);
    }
    if (result.text !== text) {
      changed += 1;
      if (write) writeFileSync(file, result.text);
    }
  }
  console.log(
    changed === 0
      ? "All installer pins are current."
      : write
        ? `Updated ${changed} module(s). Run pnpm test, review the diff, then commit.`
        : `${changed} module(s) would change. Re-run with --write to update them.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
