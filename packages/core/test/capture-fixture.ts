import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Fake secrets planted in the fixture. None of them may appear in any capture output.
 * Prefixed ones are assembled at runtime so secret scanners never see a token literal.
 */
export const FAKE_SECRETS = [
  ["sk", "ant-FAKE0123456789abcdefghijklmn"].join("-"),
  "fake-api-key-value-123",
  ["ghp", "FAKEabcdefghijklmnopqrstuvwxyz0123"].join("_"),
  "ctx7sk-FAKE-1234567890abcdef",
  "hunter2-fake-password",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.ZmFrZXNpZ25hdHVyZWZha2U",
  "Zx9Qp2Lm7Rt4Vw8Ks3Hd6Jf1Gb5Nc0Ya",
];

function put(root: string, rel: string, content: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/**
 * Writes a fake Claude dir (with caches that must be ignored) and a fake `.claude.json`.
 * `statuslineRef` is how settings.json refers to the status line script.
 */
export function writeClaudeFixture(claudeDir: string, claudeJson: string, statuslineRef: string) {
  put(
    claudeDir,
    "CLAUDE.md",
    `# Me\n- be terse\n- test key: ${FAKE_SECRETS[0]}\n- random: ${FAKE_SECRETS[6]}\n`,
  );
  put(
    claudeDir,
    "settings.json",
    JSON.stringify(
      {
        model: "opus",
        includeCoAuthoredBy: false,
        env: { ANTHROPIC_API_KEY: FAKE_SECRETS[1], PLAIN: "visible", GH: `\${GITHUB_TOKEN}` },
        statusLine: { type: "command", command: statuslineRef },
        enabledPlugins: { "demo@market": true },
      },
      null,
      2,
    ),
  );
  put(claudeDir, "statusline.sh", "#!/bin/sh\necho status\n");
  chmodSync(join(claudeDir, "statusline.sh"), 0o755);
  put(claudeDir, "skills/commit/SKILL.md", "---\nname: commit\ndescription: x\n---\nbody\n");
  put(claudeDir, "skills/commit/scripts/run.sh", "#!/bin/sh\necho run\n");
  put(claudeDir, "agents/reviewer.md", `# Reviewer\npassword: ${FAKE_SECRETS[4]}\n`);
  put(claudeDir, "commands/git/commit.md", "Commit things.\n");
  put(claudeDir, "output-styles/terse.md", "Be terse.\n");
  // Caches and state that capture must ignore.
  put(claudeDir, "projects/p/session.jsonl", `{"k":"${FAKE_SECRETS[2]}"}\n`);
  put(claudeDir, "todos/t.json", "[]");
  put(claudeDir, "shell-snapshots/s.sh", "x");
  put(claudeDir, "statsig/s", "x");
  put(claudeDir, "ide/1.lock", "x");
  put(claudeDir, "plugins/cache/demo/plugin.json", "{}");
  put(claudeDir, ".ccc-backups/2026/settings.json", "{}");
  put(claudeDir, "history.jsonl", `${FAKE_SECRETS[3]}\n`);
  put(claudeDir, "debug.log", "x");
  put(claudeDir, "x.lock", "x");
  put(
    dirname(claudeJson),
    claudeJson.slice(dirname(claudeJson).length + 1),
    JSON.stringify({
      oauthAccount: { accessToken: FAKE_SECRETS[5] },
      projects: { "/x": { mcpServers: { local: { command: "nope" } } } },
      mcpServers: {
        context7: {
          command: "npx",
          args: ["-y", "@upstash/context7-mcp", "--api-key", FAKE_SECRETS[3]],
        },
        github: {
          type: "http",
          url: "https://api.githubcopilot.com/mcp/",
          headers: { Authorization: `Bearer ${FAKE_SECRETS[2]}` },
        },
        "env-ref": { command: "tool", env: { API_TOKEN: `\${MY_TOKEN}` } },
      },
    }),
  );
}
