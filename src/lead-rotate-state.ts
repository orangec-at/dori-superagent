import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConfigError } from "./hooks.ts";
import { refText } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";

/** `leadRotation` in `$DORI_HOME/config.json`; every field is optional. */
export type LeadRotationConfig = {
  /** Automatic rotation by the duty loop (default on); `DORI_LEAD_ROTATION=off` also turns it off. `--now` always works. */
  readonly auto: boolean;
  /**
   * Rotate when the lead's context grew by this many tokens since its session started (its baseline: the footer's
   * last reading in the session's first minutes, which holds the system prompt, tool definitions and the handoff).
   */
  readonly maxTokens: number;
  /** Rotate when the lead session is this many hours old. */
  readonly maxHours: number;
  /** How long the lead has to write its handoff document before the rotation is given up. */
  readonly handoffMinutes: number;
  /**
   * Where a successful rotation is announced: `each` runs hooks.onLeadRotation for every `[LEAD ROTATED]` line, `daily`
   * runs it at the first duty pass of a day with one summary line per earlier day that had rotations and was not
   * summarized yet (also when `auto` is off), `log` only writes rotations.log. Failures and timeouts always run the hook.
   */
  readonly notify: LeadRotationNotify;
};

export type LeadRotationNotify = "each" | "daily" | "log";
const NOTIFY_MODES: readonly LeadRotationNotify[] = ["each", "daily", "log"];

export const LEAD_ROTATION_DEFAULTS: LeadRotationConfig = {
  auto: true,
  maxTokens: 300_000,
  maxHours: 24,
  handoffMinutes: 15,
  notify: "daily",
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
  const notify: unknown = Reflect.get(raw, "notify");
  if (notify !== undefined && !NOTIFY_MODES.includes(notify as LeadRotationNotify))
    throw new ConfigError(`config.json: leadRotation.notify must be one of ${NOTIFY_MODES.join(", ")}`);
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
    notify: (notify as LeadRotationNotify | undefined) ?? LEAD_ROTATION_DEFAULTS.notify,
  };
}

/**
 * What the duty loop knows about the lead's current session. `startedAt`: when it was first seen (or rotated in).
 * `tokens`: the last context size read from its footer. `baseTokens`: the size it started with (see maxTokens); a
 * session recorded before baselines existed has none and counts from 0. `quietUntil`: no automatic rotation before then.
 */
export type LeadSession = { ref: string; startedAt: number; tokens?: number; baseTokens?: number; quietUntil?: number };

/**
 * A rotation in progress. `due`: asked for (`dori lead rotate --now`), waiting for the lead to be idle. `handoff`: the
 * lead was asked to write `file`; its inbox is held until the new session starts or the wait times out.
 */
export type Rotation = { phase: "due" | "handoff"; ref: string; at: number; reason: string; file?: string };

const dir = (root: string): string => join(root, "lead");
const sessionPath = (root: string): string => join(dir(root), "session.json");
const rotationPath = (root: string): string => join(dir(root), "rotation.json");
/** The last local day (`YYYY-MM-DD`) whose rotations the `daily` notification covered. */
const summaryPath = (root: string): string => join(dir(root), "summary.json");
export const rotationLog = (root: string): string => join(dir(root), "rotations.log");
/** The lead's standing operations document (contacts, procedures, standing cautions), kept current across rotations. */
export const operationsPath = (root: string): string => join(dir(root), "operations.md");
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
/** An unreadable summary.json counts as none, so the summary starts over instead of failing every pass. */
export const readSummarized = (root: string): string | undefined => {
  try {
    return readJson<{ through: string }>(summaryPath(root))?.through;
  } catch {
    return undefined;
  }
};
export const writeSummarized = (root: string, through: string): void => writeJson(summaryPath(root), { through });

export const logRotation = (root: string, at: number, line: string): void => {
  mkdirSync(dir(root), { recursive: true });
  appendFileSync(rotationLog(root), `${new Date(at).toISOString()} ${line}\n`);
};

/** True while `ref` is a lead writing its handoff: nothing is delivered to it, so no message dies with the old session. */
export const rotating = (root: string, ref: SessionRef): boolean => {
  const r = readRotation(root);
  return r?.phase === "handoff" && r.ref === refText(ref);
};
