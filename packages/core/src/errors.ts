export type CatalogErrorCode =
  | "invalid_catalog"
  | "invalid_module"
  | "invalid_profile"
  | "invalid_capture_config"
  | "unknown_module"
  | "unknown_profile"
  | "cyclic_requires"
  | "empty_selection"
  | "unsafe_path";

/** Raised for catalog, validation and selection problems (CLI exit code 3). */
export class CatalogError extends Error {
  readonly code: CatalogErrorCode;

  constructor(code: CatalogErrorCode, message: string) {
    super(message);
    this.name = "CatalogError";
    this.code = code;
  }
}
