import type {
  ApplyResult,
  Catalog,
  DoctorReport,
  Plan,
  PlanAction,
  Selection,
  StatusReport,
  StepStatus,
} from "@claude-curated/core";
import pc from "picocolors";

export const EXIT = { ok: 0, failure: 1, usage: 2, catalog: 3, cancelled: 130 } as const;

/** A usage or refusal problem: exit code 2. */
export class UsageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UsageError";
    this.code = code;
  }
}

export type Colors = ReturnType<typeof pc.createColors>;

export function makeColors(enabled: boolean): Colors {
  return pc.createColors(enabled && pc.isColorSupported);
}

export function writeJson(doc: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
}

export function errorDoc(code: string, message: string, exitCode: number) {
  return { schema: "ccc.error/v1", error: { code, message }, exitCode };
}

const ACTIONS: PlanAction[] = ["create", "update", "unchanged", "run", "skip"];
const STATUSES: StepStatus[] = ["done", "unchanged", "skipped", "failed", "planned"];

function countBy<K extends string>(keys: K[], values: K[]): Record<K, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
  for (const value of values) counts[value] += 1;
  return counts;
}

export function planSummary(plan: Plan): Record<PlanAction, number> {
  return countBy(
    ACTIONS,
    plan.modules.flatMap((m) => m.steps.map((s) => s.action)),
  );
}

export function listDoc(catalog: Catalog) {
  return {
    schema: "ccc.list/v1",
    catalogDir: catalog.dir,
    modules: catalog.modules.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      tags: m.tags ?? [],
      requires: m.requires ?? [],
      steps: m.steps.length,
    })),
    profiles: catalog.profiles,
  };
}

export function planDoc(plan: Plan, selection: Selection) {
  return {
    schema: "ccc.plan/v1",
    claudeDir: plan.claudeDir,
    selection: { profile: selection.profile ?? null, modules: selection.modules ?? [] },
    summary: planSummary(plan),
    modules: plan.modules.map((m) => ({
      id: m.id,
      name: m.name,
      steps: m.steps.map(({ step: _step, ...rest }) => ({ blocked: false, ...rest })),
    })),
  };
}

export function applyDoc(result: ApplyResult, selection: Selection) {
  return {
    schema: "ccc.apply/v1",
    claudeDir: result.claudeDir,
    selection: { profile: selection.profile ?? null, modules: selection.modules ?? [] },
    dryRun: result.dryRun,
    ok: result.ok,
    backupDir: result.backupDir,
    summary: countBy(
      STATUSES,
      result.modules.flatMap((m) => m.steps.map((s) => s.status)),
    ),
    modules: result.modules,
  };
}

export function statusDoc(report: StatusReport) {
  return { schema: "ccc.status/v1", ...report };
}

export function doctorDoc(report: DoctorReport) {
  return { schema: "ccc.doctor/v1", ...report };
}

// ---------- human renderers ----------

export function actionColor(c: Colors, action: PlanAction | StepStatus): (s: string) => string {
  switch (action) {
    case "create":
    case "done":
      return c.green;
    case "update":
      return c.yellow;
    case "run":
    case "planned":
      return c.cyan;
    case "failed":
      return c.red;
    case "skip":
    case "skipped":
      return c.magenta;
    default:
      return c.dim;
  }
}

function target(step: { dest?: string; command?: string[] }): string {
  return step.dest ?? step.command?.join(" ") ?? "";
}

export function renderPlan(plan: Plan, c: Colors): string {
  const lines: string[] = [];
  for (const mod of plan.modules) {
    lines.push(c.bold(`${mod.name} ${c.dim(`(${mod.id})`)}`));
    for (const step of mod.steps) {
      const color = actionColor(c, step.action);
      const detail = step.summary || step.reason;
      lines.push(`  ${color(step.action.padEnd(9))} ${target(step)} ${c.dim(detail)}`);
    }
  }
  const summary = planSummary(plan);
  lines.push(
    "",
    ACTIONS.filter((a) => summary[a] > 0)
      .map((a) => actionColor(c, a)(`${summary[a]} ${a}`))
      .join(", ") || "nothing to do",
  );
  return lines.join("\n");
}

export function renderApply(result: ApplyResult, c: Colors): string {
  const lines: string[] = [];
  for (const mod of result.modules) {
    lines.push(c.bold(`${mod.ok ? c.green("✔") : c.red("✖")} ${mod.name}`));
    for (const step of mod.steps) {
      const color = actionColor(c, step.status);
      lines.push(`  ${color(step.status.padEnd(9))} ${target(step)} ${c.dim(step.message)}`);
    }
  }
  if (result.backupDir) lines.push("", `Backups: ${result.backupDir}`);
  if (result.dryRun) lines.push("", c.dim("Dry run: nothing was written."));
  return lines.join("\n");
}

export function renderStatus(report: StatusReport, c: Colors): string {
  const icon = { applied: c.green("●"), partial: c.yellow("◐"), "not-applied": c.dim("○") };
  return [
    `Claude dir: ${report.claudeDir}`,
    ...report.modules.map(
      (m) =>
        `${icon[m.state]} ${m.id.padEnd(24)} ${m.state} ${c.dim(`(${m.satisfied}/${m.satisfied + m.pending} steps)`)}`,
    ),
  ].join("\n");
}

export function renderDoctor(report: DoctorReport, c: Colors): string {
  return report.checks
    .map((check) => {
      const mark = check.ok ? c.green("✔") : check.required ? c.red("✖") : c.yellow("!");
      const fix = !check.ok && check.fix ? `\n    ${c.dim(`fix: ${check.fix}`)}` : "";
      return `${mark} ${check.id.padEnd(11)} ${check.message}${fix}`;
    })
    .join("\n");
}

export function renderList(catalog: Catalog, c: Colors): string {
  return [
    c.bold("Profiles"),
    ...catalog.profiles.map(
      (p) => `  ${p.id.padEnd(22)} ${p.description} ${c.dim(`[${p.modules.join(", ")}]`)}`,
    ),
    "",
    c.bold("Modules"),
    ...catalog.modules.map((m) => `  ${m.id.padEnd(22)} ${m.description}`),
  ].join("\n");
}
