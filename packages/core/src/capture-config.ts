import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CaptureOptions } from "./capture";
import { CatalogError } from "./errors";
import { isPlainObject } from "./merge";
import { privateDomainsFromEnv } from "./secrets";

/** Name of the optional capture config file at the root of a catalog. */
export const CAPTURE_CONFIG_FILE = "capture.config.json";

/** Reason reported for settings left out by the capture config. */
export const CAPTURE_CONFIG_REASON = "ignored by capture config";

/** What `ccc capture` leaves out or treats as private, per catalog. */
export interface CaptureConfig {
  /** JSON pointers dropped from the captured settings.json. */
  ignoreSettings: string[];
  /** Patterns (JavaScript regular expressions) of string settings array items dropped. */
  ignoreSettingsItems: string[];
  /** Domains whose host names are private infrastructure (`CCC_PRIVATE_DOMAINS` overrides). */
  privateDomains: string[];
}

/** Built-in defaults when no catalog has a capture config: nothing extra is left out. */
export const DEFAULT_CAPTURE_CONFIG: Readonly<CaptureConfig> = Object.freeze({
  ignoreSettings: [],
  ignoreSettingsItems: [],
  privateDomains: [],
});

const KEYS = new Set([
  "$schema",
  "$comment",
  "ignoreSettings",
  "ignoreSettingsItems",
  "privateDomains",
]);

/**
 * Reads `<catalogDir>/capture.config.json`. Returns null when the file does not exist; throws
 * `invalid_capture_config` when it is not valid. Missing fields take the empty defaults.
 */
export function loadCaptureConfig(catalogDir: string): CaptureConfig | null {
  const path = join(catalogDir, CAPTURE_CONFIG_FILE);
  if (!existsSync(path)) return null;
  const invalid = (why: string) =>
    new CatalogError("invalid_capture_config", `${path}: ${why} (nothing was captured)`);
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw invalid(`not valid JSON (${(error as Error).message})`);
  }
  if (!isPlainObject(doc)) throw invalid("must be a JSON object");
  for (const key of Object.keys(doc)) {
    if (!KEYS.has(key)) throw invalid(`unknown key "${key}"`);
  }
  const strings = (key: keyof CaptureConfig): string[] => {
    const value = doc[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item !== "")) {
      throw invalid(`"${key}" must be a list of non-empty strings`);
    }
    return value as string[];
  };
  const ignoreSettings = strings("ignoreSettings");
  for (const pointer of ignoreSettings) {
    if (!pointer.startsWith("/"))
      throw invalid(`ignoreSettings "${pointer}" is not a JSON pointer`);
  }
  const ignoreSettingsItems = strings("ignoreSettingsItems");
  for (const pattern of ignoreSettingsItems) {
    try {
      new RegExp(pattern);
    } catch {
      throw invalid(`ignoreSettingsItems "${pattern}" is not a valid regular expression`);
    }
  }
  const privateDomains = strings("privateDomains").map((domain) => domain.trim().toLowerCase());
  return { ignoreSettings, ignoreSettingsItems, privateDomains };
}

/**
 * Capture options from a config: ignored pointers, item patterns (reason
 * {@link CAPTURE_CONFIG_REASON}) and private domains, which `CCC_PRIVATE_DOMAINS` overrides.
 */
export function captureConfigOptions(
  config: CaptureConfig,
  env: NodeJS.ProcessEnv = process.env,
): Pick<CaptureOptions, "ignoreSettings" | "ignoreSettingsItems" | "privateDomains"> {
  return {
    ignoreSettings: [...config.ignoreSettings],
    ignoreSettingsItems: config.ignoreSettingsItems.map((pattern) => ({
      match: new RegExp(pattern),
      reason: CAPTURE_CONFIG_REASON,
    })),
    privateDomains: privateDomainsFromEnv(env, config.privateDomains),
  };
}
