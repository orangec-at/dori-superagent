import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConfigError } from "./hooks.ts";
import { refText } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";

/** `leadRotation` in `$DORI_HOME/config.json`; every field is optional. */
export type LeadRotationConfig = {
  /** Automatic rotation by the duty loop (default on); `DORI_LEAD_ROTATION=off` also turns it off. `--now` always works. */
  readonly auto: boolean;
  /** Rotate when the lead's footer shows at least this many context tokens. */
  readonly maxTokens: number;
  /** Rotate when the lead session is this many hours old. */
  readonly maxHours: number;
  /** How long the lead has to write its handoff document before the rotation is given up. */
  readonly handoffMinutes: number;
};

export const LEAD_ROTATION_DEFAULTS: LeadRotationConfig = {
  auto: true,
  maxTokens: 300_000,
  maxHours: 24,
  handoffMinutes: 15,
};

export function loadLeadRotation(root: string): LeadRotationConfig {
  const path = join(root, "config.json");
  const raw: unknown = existsSync(path)
    ? Reflect.get(JSON.parse(readFileSync(path, "utf8")) as object, "leadRotation")
    : undefined;
  const off = process.env["DORI_LEAD_ROTATION"] === "off";
  if (raw === undefined) return { ...LEAD_ROTATION_DEFAULTS, auto: !off };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ConfigError("config.json: leadRotation must be an object");
  const auto: unknown = Reflect.get(raw, "auto");
  if (auto !== undefined && typeof auto !== "boolean")
    throw new ConfigError("config.json: leadRotation.auto must be true or false");
  const num = (k: "maxTokens" | "maxHours" | "handoffMinutes"): number => {
    const v: unknown = Reflect.get(raw, k);
    if (v === undefined) return LEAD_ROTATION_DEFAULTS[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0)
      throw new ConfigError(`config.json: leadRotation.${k} must be a positive number`);
    return v;
  };
  return {
    auto: auto !== false && !off,
    maxTokens: num("maxTokens"),
    maxHours: num("maxHours"),
    handoffMinutes: num("handoffMinutes"),
  };
}

/**
 * What the duty loop knows about the lead's current session. `startedAt`: when it was first seen (or rotated in).
 * `tokens`: the last context size read from its footer. `quietUntil`: no automatic rotation before this time.
 */
export type LeadSession = { ref: string; startedAt: number; tokens?: number; quietUntil?: number };

/**
 * A rotation in progress. `due`: asked for (`dori lead rotate --now`), waiting for the lead to be idle. `handoff`: the
 * lead was asked to write `file`; its inbox is held until the new session starts or the wait times out.
 */
export type Rotation = { phase: "due" | "handoff"; ref: string; at: number; reason: string; file?: string };

const dir = (root: string): string => join(root, "lead");
const sessionPath = (root: string): string => join(dir(root), "session.json");
const rotationPath = (root: string): string => join(dir(root), "rotation.json");
export const rotationLog = (root: string): string => join(dir(root), "rotations.log");
export const handoffPath = (root: string, at: number): string =>
  join(root, "handoff", `${new Date(at).toISOString().replaceAll(":", "-")}.md`);

const readJson = <T>(path: string): T | undefined =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

export const readSession = (root: string): LeadSession | undefined => readJson(sessionPath(root));
export const writeSession = (root: string, s: LeadSession): void => writeJson(sessionPath(root), s);
export const readRotation = (root: string): Rotation | undefined => readJson(rotationPath(root));
export const writeRotation = (root: string, r: Rotation): void => writeJson(rotationPath(root), r);
export const clearRotation = (root: string): void => rmSync(rotationPath(root), { force: true });

export const logRotation = (root: string, at: number, line: string): void => {
  mkdirSync(dir(root), { recursive: true });
  appendFileSync(rotationLog(root), `${new Date(at).toISOString()} ${line}\n`);
};

/** True while `ref` is a lead writing its handoff: nothing is delivered to it, so no message dies with the old session. */
export const rotating = (root: string, ref: SessionRef): boolean => {
  const r = readRotation(root);
  return r?.phase === "handoff" && r.ref === refText(ref);
};
