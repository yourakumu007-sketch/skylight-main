// Persisted config store. Loads config.json (merged onto defaults), applies
// patches, persists to disk, and notifies subscribers (the WS hub).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_CONFIG, mergeConfig, type Config } from "@shared/index.js";

type Listener = (config: Config) => void;
const RADIO_URL_ERROR = "radioUrl must be an http or https URL";

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

function validateRadioUrl(radioUrl: unknown): void {
  if (typeof radioUrl !== "string") {
    throw new ConfigValidationError(RADIO_URL_ERROR);
  }

  try {
    const { protocol } = new URL(radioUrl);
    if (protocol === "http:" || protocol === "https:") return;
  } catch {
    // Fall through to the common validation error.
  }

  throw new ConfigValidationError(RADIO_URL_ERROR);
}

function validateConfigWrite(config: Partial<Config>): void {
  if (config && Object.prototype.hasOwnProperty.call(config, "radioUrl")) {
    validateRadioUrl(config.radioUrl);
  }
}

export class ConfigStore {
  private config: Config;
  private listeners = new Set<Listener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private path: string,
    private defaults: Config = DEFAULT_CONFIG,
  ) {
    this.config = defaults;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      this.config = mergeConfig(this.defaults, JSON.parse(raw) as Partial<Config>);
    } catch {
      this.config = this.defaults; // first run
    }
  }

  get(): Config {
    return this.config;
  }

  patch(patch: Partial<Config>): Config {
    validateConfigWrite(patch);
    this.config = mergeConfig(this.config, patch);
    this.emit();
    this.scheduleSave();
    return this.config;
  }

  set(config: Config): Config {
    validateConfigWrite(config);
    this.config = mergeConfig(this.defaults, config);
    this.emit();
    this.scheduleSave();
    return this.config;
  }

  reset(): Config {
    this.config = this.defaults;
    this.emit();
    this.scheduleSave();
    return this.config;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.config);
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), 400);
  }

  private async save(): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, JSON.stringify(this.config, null, 2), "utf8");
    } catch (err) {
      console.error("[config] save failed:", err);
    }
  }
}
