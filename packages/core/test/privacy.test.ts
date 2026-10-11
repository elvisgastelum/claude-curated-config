import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  apply,
  captureClaudeConfig,
  DEFAULT_PRIVATE_DOMAINS,
  findPrivate,
  loadCatalog,
  plan,
  privateDomainsFromEnv,
  writeCapture,
} from "../src/index";
import { Redactor } from "../src/secrets";
import { tempDir } from "./helpers";

// Example hosts only: never real infrastructure in tests.
const DOMAINS = ["example-private.com"];
const spans = (text: string, domains = DOMAINS) =>
  findPrivate(text, domains).map((s) => text.slice(s.start, s.end));

describe("findPrivate", () => {
  it("flags hosts under private domains, tailnet and .local hosts and private IPv4", () => {
    expect(spans("go to https://svc.example-private.com/mcp now")).toEqual([
      "svc.example-private.com",
    ]);
    expect(spans("apex example-private.com and a.b.EXAMPLE-PRIVATE.com")).toEqual([
      "example-private.com",
      "a.b.EXAMPLE-PRIVATE.com",
    ]);
    expect(spans("ssh box.tail1234.ts.net; printer at http://nas.local.")).toEqual([
      "box.tail1234.ts.net",
      "nas.local",
    ]);
    // .local hosts only in a URL/host context: scheme, user@, or :port.
    expect(spans("http://nas.local/x me@pi.local nas.local:8080 a.b.local:22")).toEqual([
      "nas.local",
      "pi.local",
      "nas.local",
      "a.b.local",
    ]);
    expect(spans("10.0.0.5 172.16.4.2 172.31.255.1 192.168.1.20 100.64.0.1 100.127.9.9")).toEqual([
      "10.0.0.5",
      "172.16.4.2",
      "172.31.255.1",
      "192.168.1.20",
      "100.64.0.1",
      "100.127.9.9",
    ]);
  });

  it("leaves public addresses, file names and look-alikes alone", () => {
    expect(
      spans(
        "1.2.3.4 8.8.8.8 172.32.0.1 192.169.1.1 100.128.0.1 100.63.0.1 10.2.3 v10.0.0.1.2 999.10.0.1",
      ),
    ).toEqual([]);
    expect(spans("settings.local.json .env.local not-example-private.com.evil.org")).toEqual([]);
    // Bare .local names are file names more often than hosts.
    expect(spans("edit foo.local and config.prod.local, see notes.local.")).toEqual([]);
    expect(spans("cp foo.local /tmp/foo.local; path=dir/foo.local")).toEqual([]);
    expect(spans("myexample-private.com example-private.community")).toEqual([]);
    expect(spans("svc.example-private.com", [])).toEqual([]);
  });

  it("reads CCC_PRIVATE_DOMAINS (comma-separated) with a default", () => {
    expect(privateDomainsFromEnv({})).toEqual(DEFAULT_PRIVATE_DOMAINS);
    expect(DEFAULT_PRIVATE_DOMAINS).toEqual(["elvisgastelum.com"]);
    expect(
      privateDomainsFromEnv({ CCC_PRIVATE_DOMAINS: " A.example.com, b.example.org ,," }),
    ).toEqual(["a.example.com", "b.example.org"]);
    expect(privateDomainsFromEnv({ CCC_PRIVATE_DOMAINS: "" })).toEqual([]);
  });
});

describe("privacy redaction", () => {
  it("replaces flagged values with CCC_INPUT_* placeholders declared as inputs", () => {
    const redactor = new Redactor("personal-x", "MCP_SVC", new Set(), { privateDomains: DOMAINS });
    const out = redactor.redactJson(
      {
        url: "https://svc.example-private.com/mcp",
        args: ["--host", "10.0.0.5"],
        again: "svc.example-private.com",
      },
      ".claude.json",
      "/mcpServers/svc",
    ) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toMatch(/example-private|10\.0\.0\.5/);
    expect(out.url).toMatch(/^https:\/\/\$\{CCC_INPUT_MCP_SVC_[A-Z0-9_]+\}\/mcp$/);
    // The same value maps to the same placeholder.
    expect(out.again).toBe((out.url as string).slice(8, -4));
    expect(redactor.inputs.map((i) => i.name)).toHaveLength(2);
    expect(redactor.secrets).toEqual([]);
    expect(redactor.redactions).toEqual([]);
    expect(redactor.privacy.map((p) => p.location)).toEqual([
      ".claude.json /mcpServers/svc/url",
      ".claude.json /mcpServers/svc/args/1",
      ".claude.json /mcpServers/svc/again",
    ]);
  });
});

describe("capture privacy scan", () => {
  it("reports privacy findings, writes inputs and applies them back", () => {
    const root = tempDir("ccc-privacy-");
    const claudeDir = join(root, "claude");
    const claudeJson = join(root, "claude.json");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "CLAUDE.md"),
      "# Me\n- deploy to svc.example-private.com (10.1.2.3)\n- NAS: http://nas.local\n",
    );
    writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: { svc: { type: "http", url: "https://svc.example-private.com/mcp" } },
      }),
    );
    const capture = captureClaudeConfig({ claudeDir, claudeJson, privateDomains: DOMAINS });
    expect(capture.redactions).toEqual([]);
    expect(capture.privacy.map((p) => p.module).sort()).toEqual([
      "personal-claude-md",
      "personal-claude-md",
      "personal-claude-md",
      "personal-mcp-svc",
    ]);
    for (const entry of capture.privacy) {
      expect(entry.placeholder).toMatch(/^\$\{CCC_INPUT_[A-Z0-9_]+\}$/);
      expect(JSON.stringify(entry)).not.toMatch(/example-private|10\.1\.2\.3|nas\.local/);
    }
    const out = join(root, "catalog");
    writeCapture(capture, { outDir: out });
    const written = readFileSync(join(out, "modules/personal-claude-md/CLAUDE.md"), "utf8");
    expect(written).not.toMatch(/example-private|10\.1\.2\.3|nas\.local/);
    const catalog = loadCatalog(out);
    const md = catalog.modules.find((m) => m.id === "personal-claude-md");
    expect(md?.inputs?.length).toBe(3);
    expect(md?.secrets).toBeUndefined();

    const values = Object.fromEntries(
      (md?.inputs ?? []).map((input) => [input.name, `value-of-${input.name}`]),
    );
    const target = join(root, "target");
    apply(plan({ catalog, claudeDir: target, modules: ["personal-claude-md"], secrets: values }));
    const applied = readFileSync(join(target, "CLAUDE.md"), "utf8");
    for (const name of Object.keys(values)) expect(applied).toContain(`value-of-${name}`);
  });
});
