import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export interface AppConfig {
  version: 1;
  mode: "local";
  localAnalytics: false;
}

const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  mode: "local",
  localAnalytics: false,
};

export function parseAppConfig(value: unknown): AppConfig {
  if (!value || typeof value !== "object") throw new Error("猫步·千境 config must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new Error("unsupported 猫步·千境 config version");
  if (raw.mode !== "unconfigured" && raw.mode !== "local" && raw.mode !== "cloud") {
    throw new Error("invalid 猫步·千境 mode");
  }
  // Older installations may have selected Cloud. Read them as Local without
  // deleting, importing, or uploading the separate Cloud cache or credentials.
  return {
    version: 1,
    mode: "local",
    localAnalytics: false,
  };
}

export class AppConfigStore {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  read(): AppConfig {
    if (!existsSync(this.path)) return { ...DEFAULT_CONFIG };
    return parseAppConfig(JSON.parse(readFileSync(this.path, "utf8")));
  }

  write(config: AppConfig): AppConfig {
    const normalized = parseAppConfig(config);
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
    return normalized;
  }

  setMode(mode: "local"): AppConfig {
    if (mode !== "local") throw new Error("Only local mode is supported");
    const current = this.read();
    return this.write({ ...current, mode: "local" });
  }
}
