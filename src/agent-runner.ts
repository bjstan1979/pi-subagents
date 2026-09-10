/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  type InlineExtension,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getConfig, getMemoryToolNames, getReadOnlyMemoryToolNames, getToolNamesForType } from "./agent-types.js";
import { runInChildSessionContext } from "./child-context.js";
import { buildParentContext, extractText } from "./context.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { detectEnv } from "./env.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory.js";
import { createNestedSubagentTools, getMaxSubagentDepth, type NestedAgentManager } from "./nested-tools.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { preloadSkills } from "./skill-loader.js";
import {
  createStructuredCapture,
  createStructuredOutputTool,
  STRUCTURED_OUTPUT_TOOL_NAME,
  type StructuredCapture,
  structuredRetryPrompt,
} from "./structured-output.js";
import type { SubagentType, ThinkingLevel } from "./types.js";
import type { LifetimeUsage } from "./usage.js";
import type { CompiledSchema } from "./workflow/json-schema.js";

/**
 * Tool names registered by THIS extension. Single source of truth so the
 * registration sites (index.ts) and the subagent exclusion list below can't
 * drift apart. These are our own tools, not pi built-ins, so they can't be
 * derived from pi — but they only need defining once.
 */
export const SUBAGENT_TOOL_NAMES = {
  AGENT: "Agent",
  WORKFLOW: "SubagentWorkflow",
  GET_RESULT: "get_subagent_result",
  STEER: "steer_subagent",
} as const;

/** Names of tools registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);

/**
 * Canonical name of an extension for `extensions: [...]` allowlist matching.
 * Lowercased — extension names match case-insensitively so `extensions: [Mcp]`
 * resolves the same as `[mcp]`. Tool names within `ext:foo/bar` are not affected.
 * Directory extensions (`foo/index.ts`) resolve to the parent directory name;
 * single-file extensions to the basename minus `.ts`/`.js`.
 */
export function extensionCanonicalName(extPath: string): string {
  const base = basename(extPath);
  const name = base === "index.ts" || base === "index.js"
    ? basename(dirname(extPath))
    : base.replace(/\.(ts|js)$/, "");
  return name.toLowerCase();
}

/**
 * The unscoped, lowercased npm short name of the pi package that DECLARES
 * `extPath` as an extension entry — or undefined if the entry doesn't belong to
 * such a package.
 *
 * Climbs from the entry's directory looking for the package that owns it, and
 * stays strictly within that package's tree by stopping at two structural
 * boundaries — no hardcoded depth:
 *   - the FIRST `package.json` found (the package root); the entry's own
 *     manifest always sits at the root, above the entry, below any node_modules.
 *   - a `node_modules` directory: a package never spans one (it's where OTHER
 *     packages live), so reaching it means we've climbed out of the package —
 *     stop before reading a consumer's or parent package's manifest.
 * The name is then taken only when that root's `pi.extensions` manifest actually
 * lists this entry. That "declares this entry" check is deliberate: our own test
 * fixtures live under this repo, whose root manifest declares `./src/index.ts`
 * as `@tintinweb/pi-subagents`, so a looser rule would misattribute every
 * co-located file to `pi-subagents`.
 */
function extensionPackageName(extPath: string): string | undefined {
  // `builtin:<name>` names no file; climbing from it would read the process cwd's manifest.
  if (extPath.startsWith("builtin:")) return undefined;
  const entry = resolve(extPath);
  let dir = dirname(extPath);
  for (;;) {
    // Climbing into node_modules means we've left the owning package's tree.
    if (basename(dir) === "node_modules") return undefined;
    let pkg: { name?: unknown; pi?: { extensions?: unknown } };
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return undefined; // walked to the filesystem root
      dir = parent;
      continue;
    }
    // First package.json wins — it's the package root; decide here.
    const entries = pkg.pi?.extensions;
    if (
      typeof pkg.name === "string" &&
      Array.isArray(entries) &&
      entries.some((e) => typeof e === "string" && resolve(dir, e) === entry)
    ) {
      const short = pkg.name.startsWith("@") ? pkg.name.slice(pkg.name.indexOf("/") + 1) : pkg.name;
      return short.toLowerCase();
    }
    return undefined;
  }
}

/**
 * All names an extension answers to for allowlist matching (lowercased): its
 * path-derived {@link extensionCanonicalName} plus, when a pi package manifest
 * declares this entry, that package's unscoped short name (`@scope/foo` → `foo`).
 * #143: an extension installed via `pi.extensions: ["./src/index.ts"]` would
 * otherwise only ever match as `src` (the source directory), never by its
 * package name. The path-derived name is preserved, so it keeps matching too.
 */
export function extensionCanonicalNames(extPath: string): string[] {
  const canonical = extensionCanonicalName(extPath);
  const pkg = extensionPackageName(extPath);
  return pkg && pkg !== canonical ? [canonical, pkg] : [canonical];
}

/**
 * Classify `extensions: string[]` frontmatter entries for the loader-level filter.
 *
 * An entry is a PATH iff it contains a path separator or starts with `~`; otherwise
 * it is a NAME. `"*"` sets the wildcard flag (keep all default-discovered extensions).
 *
 * Path entries are resolved (`~` expanded, made absolute against `cwd`) into `paths`
 * — and their canonical name is also added to `names`. The loader override matches
 * everything by canonical name, so path-loaded extensions are matched via their name
 * rather than their post-staging `Extension.path`.
 */
export function parseExtensionsSpec(
  entries: string[],
  cwd: string,
): { names: Set<string>; paths: string[]; wildcard: boolean } {
  const names = new Set<string>();
  const paths: string[] = [];
  let wildcard = false;
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === "*") {
      wildcard = true;
      continue;
    }
    const isPathEntry = entry.includes("/") || entry.includes("\\") || entry.startsWith("~");
    if (!isPathEntry) {
      names.add(entry.toLowerCase());
      continue;
    }
    let p = entry;
    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
      p = homedir() + p.slice(1);
    }
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    paths.push(abs);
    names.add(extensionCanonicalName(abs));
  }
  return { names, paths, wildcard };
}

/**
 * Parse raw `ext:` selector strings (from the `tools:` CSV) into the set of
 * extension names to keep loaded and a per-extension tool-narrowing map.
 *
 * `ext:foo` → `extNames` has `foo`, no narrowing entry (all of foo's tools).
 * `ext:foo/bar` → `extNames` has `foo`, `narrowing.foo` has `bar` (only `bar`).
 * A name lands in `narrowing` only when a `/tool` form is seen, so a bare
 * `ext:foo` alongside `ext:foo/bar` leaves narrowing in effect (narrowing wins).
 * The split is on the first `/`; extension canonical names never contain `/`.
 */
export function parseExtSelectors(entries: string[]): {
  extNames: Set<string>;
  narrowing: Map<string, Set<string>>;
} {
  const extNames = new Set<string>();
  const narrowing = new Map<string, Set<string>>();
  for (const raw of entries) {
    if (!raw) continue;
    const body = raw.slice("ext:".length);
    const slash = body.indexOf("/");
    // Extension name matches case-insensitively (matches the loader-side canonical
    // name). Tool names are case-preserved — they're matched against pi-mono's
    // registered identifiers, which are case-sensitive.
    const name = (slash === -1 ? body : body.slice(0, slash)).trim().toLowerCase();
    if (!name) continue;
    extNames.add(name);
    if (slash === -1) continue;
    const tool = body.slice(slash + 1).trim();
    if (!tool) continue;
    let set = narrowing.get(name);
    if (!set) {
      set = new Set();
      narrowing.set(name, set);
    }
    set.add(tool);
  }
  return { extNames, narrowing };
}

/**
 * Keep a subagent's tool scope correct as extensions register tools over time.
 *
 * Extensions may call `registerTool` long after load — pi-mcp from `session_start`,
 * context-mode from `before_agent_start` — so scope has to be re-derived rather than
 * snapshotted. `registerTool` writes into the very `extension.tools` maps this reads,
 * so `inScope()` sees late arrivals on the next call.
 *
 * Two enforcement points, because neither covers the whole picture:
 *
 *   - `turn_end` re-narrows the ACTIVE set. pi emits `turn_end` immediately before
 *     `prepareNextTurn` re-snapshots `agent.state.tools`, and session listeners run
 *     synchronously, so the narrow lands in time for turns 2..N.
 *   - `beforeToolCall` blocks out-of-scope calls. Turn 1 cannot be narrowed at all:
 *     `before_agent_start` fires INSIDE `prompt()` and may widen the tool set, but
 *     `createContextSnapshot()` freezes that turn's tools immediately after — there
 *     is no hook in between. A call-time check is the only correct guard there.
 *
 * Both are installed on the session and deliberately NOT unsubscribed: they must
 * outlive the `runAgent` call so resumed/steered turns stay scoped. pi's `dispose()`
 * clears `_eventListeners`, so they die with the session rather than leaking.
 *
 * Only meaningful when extensions are loaded — under `noExtensions`/`isolated` the
 * static `allowedToolNames` allowlist already gates the registry itself.
 */
interface HardLimitController {
  isHardLimited: () => boolean;
  hardLimitAllowedTools: () => string[];
}

const activeHardLimitControllers = new WeakMap<AgentSession, HardLimitController>();
export const sessionStructuredCaptures = new WeakMap<AgentSession, StructuredCapture>();

const READ_ONLY_TOOL_NAMES = new Set([
  "read",
  "read_skill",
  "grep",
  "find",
  "ls",
  "ast_grep",
  "web_search",
  "web_extract",
]);
const MODIFYING_TOOL_NAMES = new Set(["write", "edit", "bash", "powershell", "undo_last_edit", "rollback", "ts_morph"]);

const READ_ONLY_SHELL_BINARIES = new Set([
  "pwd",
  "ls",
  "dir",
  "echo",
  "printf",
  "cat",
  "head",
  "tail",
  "more",
  "less",
  "grep",
  "rg",
  "ag",
  "ack",
  "find",
  "fdfind",
  "which",
  "whereis",
  "type",
  "file",
  "stat",
  "wc",
  "diff",
  "cmp",
  "md5sum",
  "sha256sum",
  "sha1sum",
  "du",
  "df",
  "env",
  "printenv",
  "uname",
  "whoami",
  "id",
  "hostname",
  "uptime",
  "date",
  "test",
  "true",
  "false",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
  "tag",
  "remote",
  "describe",
  "blame",
  "shortlog",
  "check-ref-format",
  "version",
  "version",
  "help",
]);

export function isReadOnlyShellCommand(rawCommand: unknown): boolean {
  if (typeof rawCommand !== "string") return false;
  const cmd = rawCommand.trim();
  if (!cmd) return false;

  if (/(?:^|[^\\])(?:>>?|<(?!\()|\|\s*tee\b)/.test(cmd)) {
    return false;
  }

  if (/\b(?:rm|mv|cp|touch|mkdir|chmod|chown|truncate|install|kill|pkill)\b/.test(cmd)) {
    return false;
  }

  const segments = cmd.split(/(?:&&|\|\||;|\|)/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;

  for (const segment of segments) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    let binIdx = 0;
    while (binIdx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[binIdx])) {
      binIdx++;
    }
    if (binIdx >= tokens.length) return false;

    let bin = tokens[binIdx];
    const lastSlash = bin.lastIndexOf("/");
    if (lastSlash >= 0) {
      bin = bin.slice(lastSlash + 1);
    }
    bin = bin.toLowerCase();

    if (
      bin === "get-childitem" ||
      bin === "get-content" ||
      bin === "get-location" ||
      bin === "get-item" ||
      bin === "get-command" ||
      bin === "gci" ||
      bin === "gc" ||
      bin === "gl"
    ) {
      continue;
    }

    if (tokens.length === binIdx + 2) {
      const arg = tokens[binIdx + 1];
      if (
        arg === "--version" ||
        arg === "-v" ||
        arg === "-V" ||
        arg === "--help" ||
        arg === "-h"
      ) {
        continue;
      }
    }

    if (bin === "git") {
      let subcmdIdx = binIdx + 1;
      while (subcmdIdx < tokens.length && tokens[subcmdIdx].startsWith("-")) {
        subcmdIdx++;
      }
      if (subcmdIdx >= tokens.length) {
        if (
          tokens
            .slice(binIdx + 1)
            .some((t) => t === "--version" || t === "-v" || t === "--help")
        ) {
          continue;
        }
        return false;
      }
      const subcmd = tokens[subcmdIdx].toLowerCase();
      if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcmd)) {
        return false;
      }
      const subcmdArgs = tokens.slice(subcmdIdx + 1);
      if (subcmdArgs.some((t) => t.startsWith("--output") || t === "-o")) {
        return false;
      }
      if (subcmd === "branch") {
        if (
          subcmdArgs.some(
            (t) =>
              t === "-d" ||
              t === "-D" ||
              t === "--delete" ||
              t === "-m" ||
              t === "-M" ||
              t === "--move" ||
              t === "-c" ||
              t === "-C" ||
              t === "--copy",
          )
        ) {
          return false;
        }
        const nonFlag = subcmdArgs.filter((t) => !t.startsWith("-"));
        if (nonFlag.length > 0) {
          return false;
        }
      } else if (subcmd === "tag") {
        if (
          subcmdArgs.some(
            (t) =>
              t === "-d" ||
              t === "--delete" ||
              t === "-a" ||
              t === "-s" ||
              t === "-u",
          )
        ) {
          return false;
        }
        const nonFlag = subcmdArgs.filter((t) => !t.startsWith("-"));
        if (nonFlag.length > 0) {
          return false;
        }
      } else if (subcmd === "remote") {
        const subSubCmd = subcmdArgs.find((t) => !t.startsWith("-"))?.toLowerCase();
        if (subSubCmd && subSubCmd !== "show" && subSubCmd !== "get-url") {
          return false;
        }
      }
      continue;
    }

    if (bin === "find" || bin === "fdfind") {
      const rest = tokens.slice(binIdx + 1);
      if (
        rest.some(
          (t) =>
            t === "-delete" ||
            t === "-exec" ||
            t === "-execdir" ||
            t === "-ok" ||
            t === "-okdir",
        )
      ) {
        return false;
      }
    }

    if (READ_ONLY_SHELL_BINARIES.has(bin)) {
      continue;
    }

    return false;
  }

  return true;
}

export function isSubpathOrEqual(childPath: string, parentPath: string): boolean {
  const normChild = normalizeFilePath(childPath);
  const normParent = normalizeFilePath(parentPath);
  if (!normParent || normParent === ".") {
    return !normChild.startsWith("/");
  }
  if (normParent === "/") {
    return normChild.startsWith("/");
  }
  if (normChild === normParent) return true;
  return normChild.startsWith(`${normParent}/`);
}

export function getLatestMutationInScope(
  scopePath: string | undefined,
  mutations: Map<string, number>,
): number {
  const normScope = scopePath ? normalizeFilePath(scopePath) : ".";
  let maxTurn = -1;
  for (const [file, turn] of mutations) {
    if (isSubpathOrEqual(file, normScope) || isSubpathOrEqual(normScope, file)) {
      if (turn > maxTurn) maxTurn = turn;
    }
  }
  return maxTurn;
}

export function normalizeFilePath(rawPath: unknown): string {
  if (typeof rawPath !== "string") return "";
  let p = rawPath.trim().replace(/\\/g, "/");
  if (!p) return "";
  while (p.startsWith("./")) {
    p = p.slice(2);
  }
  const isAbs = p.startsWith("/");
  const parts = p.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== "..") {
        resolved.pop();
      } else {
        resolved.push("..");
      }
    } else {
      resolved.push(part);
    }
  }
  const res = resolved.join("/");
  if (isAbs) {
    return `/${res}`;
  }
  return res || ".";
}

function normalizeToolArgs(name: string, args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const obj = args as Record<string, unknown>;
  if (
    name === "read" ||
    name === "read_skill" ||
    name === "edit" ||
    name === "write" ||
    name === "undo_last_edit" ||
    name === "grep" ||
    name === "find" ||
    name === "ls"
  ) {
    if (typeof obj.path === "string") {
      return { ...obj, path: normalizeFilePath(obj.path) };
    }
  } else if (name === "ts_morph") {
    if (typeof obj.filePath === "string") {
      return { ...obj, filePath: normalizeFilePath(obj.filePath) };
    }
  } else if (name === "ast_grep") {
    if (Array.isArray(obj.paths)) {
      return {
        ...obj,
        paths: obj.paths.map((p) =>
          typeof p === "string" ? normalizeFilePath(p) : p,
        ),
      };
    }
  } else if (name === "web_search") {
    if (typeof obj.query === "string") {
      return { ...obj, query: obj.query.trim() };
    }
  } else if (name === "web_extract") {
    if (typeof obj.url === "string") {
      return { ...obj, url: obj.url.trim().replace(/\/+$/, "") };
    }
  }
  return args;
}

export function getTargetFilePath(name: string, args?: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const obj = args as Record<string, unknown>;
  if (name === "edit" || name === "write" || name === "undo_last_edit") {
    return typeof obj.path === "string" ? normalizeFilePath(obj.path) : undefined;
  }
  if (name === "ts_morph" && obj.operation !== "inspect") {
    return typeof obj.filePath === "string" ? normalizeFilePath(obj.filePath) : undefined;
  }
  return undefined;
}

export function getReadFilePath(name: string, args?: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const obj = args as Record<string, unknown>;
  if (name === "read") {
    return typeof obj.path === "string" ? normalizeFilePath(obj.path) : undefined;
  }
  if (name === "ts_morph" && obj.operation === "inspect") {
    return typeof obj.filePath === "string" ? normalizeFilePath(obj.filePath) : undefined;
  }
  return undefined;
}

function isReadOnlyTool(name: string, args?: unknown): boolean {
  if (name === "ts_morph") {
    const op = (args as Record<string, unknown> | undefined)?.operation;
    return op === "inspect";
  }
  return READ_ONLY_TOOL_NAMES.has(name);
}

function isModifyingTool(name: string, args?: unknown): boolean {
  if (name === "ts_morph") {
    const op = (args as Record<string, unknown> | undefined)?.operation;
    return op !== "inspect";
  }
  if (name === "bash" || name === "powershell") {
    const cmd = (args as Record<string, unknown> | undefined)?.command;
    if (typeof cmd === "string" && isReadOnlyShellCommand(cmd)) {
      return false;
    }
    return true;
  }
  return MODIFYING_TOOL_NAMES.has(name);
}
function stableSerialize(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (typeof value === "object") {
    try {
      const keys = Object.keys(value as Record<string, unknown>).sort();
      return `{${keys
        .map((k) => `${JSON.stringify(k)}:${stableSerialize((value as Record<string, unknown>)[k])}`)
        .join(",")}}`;
    } catch {
      return String(value);
    }
  }
  return JSON.stringify(value) ?? String(value);
}

function serializeArgs(args: unknown): string {
  return stableSerialize(args);
}

function makeToolKey(name: string, args: unknown): string {
  return `${name}:${serializeArgs(normalizeToolArgs(name, args))}`;
}

interface PendingCallInfo {
  toolKey: string;
  args: unknown;
}

export function getEffectiveMutationTurn(
  toolName: string,
  toolArgs: unknown,
  loopState: LoopGuardState,
): number {
  if (
    toolName === "read_skill" ||
    toolName === "web_search" ||
    toolName === "web_extract"
  ) {
    return -1;
  }

  const obj =
    toolArgs && typeof toolArgs === "object"
      ? (toolArgs as Record<string, unknown>)
      : {};

  if (toolName === "read") {
    const rawPath =
      typeof obj.path === "string" ? normalizeFilePath(obj.path) : undefined;
    const fileMut =
      rawPath !== undefined ? (loopState.fileMutations.get(rawPath) ?? -1) : -1;
    return Math.max(loopState.lastWorkspaceMutationTurn, fileMut);
  }

  if (toolName === "ts_morph") {
    const rawPath =
      typeof obj.filePath === "string"
        ? normalizeFilePath(obj.filePath)
        : undefined;
    const fileMut =
      rawPath !== undefined ? (loopState.fileMutations.get(rawPath) ?? -1) : -1;
    return Math.max(loopState.lastWorkspaceMutationTurn, fileMut);
  }

  if (toolName === "find" || toolName === "ls") {
    const rawPath =
      typeof obj.path === "string" ? normalizeFilePath(obj.path) : ".";
    const dirMut = getLatestMutationInScope(
      rawPath,
      loopState.directoryMutations,
    );
    return Math.max(loopState.lastWorkspaceMutationTurn, dirMut);
  }

  if (toolName === "grep") {
    const rawPath =
      typeof obj.path === "string" ? normalizeFilePath(obj.path) : ".";
    const grepMut = getLatestMutationInScope(rawPath, loopState.fileMutations);
    return Math.max(loopState.lastWorkspaceMutationTurn, grepMut);
  }

  if (toolName === "ast_grep") {
    if (Array.isArray(obj.paths) && obj.paths.length > 0) {
      let maxMut = -1;
      for (const p of obj.paths) {
        if (typeof p === "string") {
          maxMut = Math.max(
            maxMut,
            getLatestMutationInScope(normalizeFilePath(p), loopState.fileMutations),
          );
        }
      }
      return Math.max(loopState.lastWorkspaceMutationTurn, maxMut);
    }
    const rawPath =
      typeof obj.path === "string" ? normalizeFilePath(obj.path) : ".";
    const astMut = getLatestMutationInScope(rawPath, loopState.fileMutations);
    return Math.max(loopState.lastWorkspaceMutationTurn, astMut);
  }

  return loopState.lastMutatingTurn;
}

export function isKeyInvalidatedByTarget(
  key: string,
  targetPath: string,
  toolName: string,
): boolean {
  try {
    const colonIdx = key.indexOf(":");
    if (colonIdx < 0) return false;
    const prefix = key.slice(0, colonIdx);
    const parsed = JSON.parse(key.slice(colonIdx + 1));

    if (prefix === "read") {
      return normalizeFilePath(parsed.path) === targetPath;
    }
    if (prefix === "ts_morph") {
      return normalizeFilePath(parsed.filePath) === targetPath;
    }
    if (prefix === "grep") {
      const grepPath = normalizeFilePath(parsed.path ?? ".");
      return isSubpathOrEqual(targetPath, grepPath);
    }
    if (prefix === "find" || prefix === "ls") {
      if (toolName !== "write") return false;
      const dirPath = normalizeFilePath(parsed.path ?? ".");
      return isSubpathOrEqual(targetPath, dirPath);
    }
    if (prefix === "ast_grep") {
      const paths: string[] =
        Array.isArray(parsed.paths) && parsed.paths.length > 0
          ? parsed.paths
          : [parsed.path ?? "."];
      return paths.some((p) => isSubpathOrEqual(targetPath, normalizeFilePath(p)));
    }
  } catch {}
  return false;
}

interface LoopGuardState {
  consecutiveFailures: Map<string, number>;
  readOnlyCalls: Map<string, number>;
  fileMutations: Map<string, number>;
  directoryMutations: Map<string, number>;
  lastWorkspaceMutationTurn: number;
  lastMutatingTurn: number;
  pendingCalls: Map<string, PendingCallInfo>;
  blockedCalls: Set<string>;
  blockedToolKeys: Set<string>;
  currentTurn: number;
}
const sessionLoopGuardStates = new WeakMap<AgentSession, LoopGuardState>();
const sessionControllersInstalled = new WeakSet<AgentSession>();

export function installSessionToolController(
  session: AgentSession,
  options: {
    inScope?: () => Set<string>;
    isHardLimited?: () => boolean;
    hardLimitAllowedTools?: () => string[];
  } = {},
): void {
  let loopState = sessionLoopGuardStates.get(session);
  if (!loopState) {
    loopState = {
      consecutiveFailures: new Map(),
      readOnlyCalls: new Map(),
      fileMutations: new Map(),
      directoryMutations: new Map(),
      lastWorkspaceMutationTurn: -1,
      lastMutatingTurn: -1,
      pendingCalls: new Map(),
      blockedCalls: new Set(),
      blockedToolKeys: new Set(),
      currentTurn: 0,
    };
    sessionLoopGuardStates.set(session, loopState);
  }

  const getIsHardLimited = (): boolean => {
    const controller = activeHardLimitControllers.get(session);
    if (controller) {
      return controller.isHardLimited();
    }
    return options.isHardLimited ? options.isHardLimited() : false;
  };

  const getHardLimitAllowedTools = (): string[] => {
    const controller = activeHardLimitControllers.get(session);
    if (controller) {
      return controller.hardLimitAllowedTools();
    }
    return options.hardLimitAllowedTools ? options.hardLimitAllowedTools() : [];
  };

  if (!sessionControllersInstalled.has(session)) {
    sessionControllersInstalled.add(session);

    if (session.agent) {
      const priorBeforeToolCall = session.agent.beforeToolCall;
      session.agent.beforeToolCall = async (context: any, signal?: AbortSignal) => {
        const toolName = context?.toolCall?.name ?? "";
        const toolArgs = context?.args ?? context?.toolCall?.arguments;
        const toolKey = makeToolKey(toolName, toolArgs);
        const callId = context?.toolCall?.id;
        if (callId) {
          loopState.pendingCalls.set(callId, { toolKey, args: toolArgs });
        }

        if (getIsHardLimited()) {
          const hardAllowed = getHardLimitAllowedTools();
          if (!hardAllowed.includes(toolName)) {
            if (callId) loopState.blockedCalls.add(callId);
            return {
              block: true,
              reason: `Tool "${toolName}" is disabled by hard limit. Provide your final answer now.`,
              ...(hardAllowed.length === 0 ? { terminate: true } : {}),
            };
          }
        }

        if (options.inScope && !options.inScope().has(toolName)) {
          if (callId) loopState.blockedCalls.add(callId);
          return {
            block: true,
            reason: `Tool "${toolName}" is not available to this subagent.`,
          };
        }

        // Tool Loop Guard: consecutive identical failing tool calls
        const failCount = loopState.consecutiveFailures.get(toolKey) ?? 0;
        if (failCount >= 2) {
          if (callId) {
            loopState.blockedCalls.add(callId);
          } else {
            loopState.blockedToolKeys.add(toolKey);
          }
          return {
            block: true,
            reason: `Tool "${toolName}" with identical arguments has failed consecutively (${failCount} times) with no intervening modifications. Repeatedly executing the identical failing call without changing arguments or fixing preconditions is blocked to prevent an unrecoverable loop. Modify your arguments or try an alternative approach.`,
          };
        }

        // Tool Loop Guard: redundant read-only execution
        if (isReadOnlyTool(toolName, toolArgs)) {
          const isPendingDuplicate = callId
            ? Array.from(loopState.pendingCalls.entries()).some(
                ([id, pending]) => id !== callId && pending.toolKey === toolKey && !loopState.blockedCalls.has(id),
              )
            : false;
          const prevTurn = loopState.readOnlyCalls.get(toolKey);
          const lastMut = getEffectiveMutationTurn(toolName, toolArgs, loopState);

          if (
            isPendingDuplicate ||
            (prevTurn !== undefined && lastMut <= prevTurn)
          ) {
            if (callId) {
              loopState.blockedCalls.add(callId);
            } else {
              loopState.blockedToolKeys.add(toolKey);
            }
            const isSameTurn = isPendingDuplicate || loopState.currentTurn === prevTurn;
            const isPrecedingTurn = prevTurn !== undefined && loopState.currentTurn === prevTurn + 1;
            const reason = isSameTurn
              ? `Tool "${toolName}" with identical arguments was already executed in this turn. Duplicate parallel executions of identical read-only calls provide no new information. Refer to the existing tool call result.`
              : isPrecedingTurn
                ? `Tool "${toolName}" with identical arguments was already executed in the preceding turn with no intervening modifications. The complete result is already available in your conversation history. Refer to the existing tool result instead of re-reading.`
                : `Tool "${toolName}" with identical arguments was already executed in turn ${(prevTurn ?? 0) + 1} with no intervening modifications. The complete result is already available in your conversation history. Refer to the existing tool result instead of re-reading.`;
            return {
              block: true,
              reason,
            };
          }
        }

        const priorResult = await priorBeforeToolCall?.(context, signal);
        if (priorResult?.block) {
          if (callId) {
            loopState.blockedCalls.add(callId);
          } else {
            loopState.blockedToolKeys.add(toolKey);
          }
        }
        return priorResult;
      };
    }

    session.subscribe?.((event: AgentSessionEvent) => {
      if (event.type === "turn_end") {
        loopState.currentTurn++;
        loopState.pendingCalls.clear();
        loopState.blockedCalls.clear();
        loopState.blockedToolKeys.clear();
      } else if (event.type === "tool_execution_start") {
        const callId = (event as any).toolCallId;
        if (callId && (event as any).args) {
          const args = (event as any).args;
          loopState.pendingCalls.set(callId, { toolKey: makeToolKey(event.toolName, args), args });
        }
      } else if (event.type === "tool_execution_end") {
        const toolName = event.toolName;
        const callId = (event as any).toolCallId;
        const pending = callId ? loopState.pendingCalls.get(callId) : undefined;
        const toolKey = pending?.toolKey ?? makeToolKey(toolName, (event as any).args);
        const toolArgs = pending?.args ?? (event as any).args;
        const wasBlocked = (callId ? loopState.blockedCalls.has(callId) : false) || loopState.blockedToolKeys.has(toolKey);
        if (callId) {
          loopState.pendingCalls.delete(callId);
          loopState.blockedCalls.delete(callId);
        }
        loopState.blockedToolKeys.delete(toolKey);
        if (wasBlocked) {
          return;
        }
        if (event.isError) {
          const count = loopState.consecutiveFailures.get(toolKey) ?? 0;
          loopState.consecutiveFailures.set(toolKey, count + 1);
        } else {
          loopState.consecutiveFailures.delete(toolKey);
          if (isModifyingTool(toolName, toolArgs)) {
            loopState.lastMutatingTurn = loopState.currentTurn;
            loopState.consecutiveFailures.clear();
            const targetPath = getTargetFilePath(toolName, toolArgs);
            if (targetPath !== undefined) {
              loopState.fileMutations.set(targetPath, loopState.currentTurn);
              if (toolName === "write") {
                loopState.directoryMutations.set(targetPath, loopState.currentTurn);
              }
              for (const [key] of loopState.readOnlyCalls) {
                if (isKeyInvalidatedByTarget(key, targetPath, toolName)) {
                  loopState.readOnlyCalls.delete(key);
                }
              }
            } else {
              loopState.lastWorkspaceMutationTurn = loopState.currentTurn;
              loopState.fileMutations.clear();
              loopState.directoryMutations.clear();
              for (const [key] of loopState.readOnlyCalls) {
                if (
                  !key.startsWith("read_skill:") &&
                  !key.startsWith("web_search:") &&
                  !key.startsWith("web_extract:")
                ) {
                  loopState.readOnlyCalls.delete(key);
                }
              }
            }
          } else if (isReadOnlyTool(toolName, toolArgs)) {
            loopState.readOnlyCalls.set(toolKey, loopState.currentTurn);
          }
        }
      }
    });
  }
}

export function installExtensionToolScope(
  session: AgentSession,
  ctx: {
    loader: DefaultResourceLoader;
    toolNames: string[];
    disallowedSet: Set<string> | undefined;
    extNames: Set<string>;
    narrowing: Map<string, Set<string>>;
    /**
     * Injected `customTools` to keep active regardless of the built-in list.
     *
     * Two kinds arrive here and they are blocked for different reasons: opt-in
     * nested-delegation tools share EXCLUDED_TOOL_NAMES' names, and
     * StructuredOutput is simply not a built-in, so neither survives a `keep`
     * seeded from `toolNames`.
     */
    readmitToolNames: Set<string>;
    /** Receives the scope check the child's nested-call gate extension applies. */
    nestedCallGate: NestedCallGate;
    isHardLimited?: () => boolean;
    hardLimitAllowedTools?: () => string[];
  },
): void {
  const { loader, toolNames, disallowedSet, extNames, narrowing, readmitToolNames, nestedCallGate } = ctx;

  const getIsHardLimited = (): boolean => {
    const controller = activeHardLimitControllers.get(session);
    if (controller) {
      return controller.isHardLimited();
    }
    return ctx.isHardLimited ? ctx.isHardLimited() : false;
  };

  const getHardLimitAllowedTools = (): string[] => {
    const controller = activeHardLimitControllers.get(session);
    if (controller) {
      return controller.hardLimitAllowedTools();
    }
    return ctx.hardLimitAllowedTools ? ctx.hardLimitAllowedTools() : [];
  };

  // The names allowed right now. Mirrors the `ext:` opt-in flip: when any `ext:`
  // selector is present, extension tools become an explicit allowlist — a loaded
  // extension not named by a selector contributes nothing (its handlers still ran),
  // and `ext:foo/bar` narrows `foo` to just `bar`.
  const inScope = (): Set<string> => {
    if (getIsHardLimited()) {
      return new Set(getHardLimitAllowedTools());
    }
    const keep = new Set(toolNames.filter((t) => !disallowedSet?.has(t)));
    const optInActive = extNames.size > 0;
    for (const extension of loader.getExtensions().extensions) {
      const canons = extensionCanonicalNames(extension.path);
      if (optInActive && !canons.some((c) => extNames.has(c))) continue;
      // First alias that carries a narrowing set — a user won't narrow one
      // extension under two different names, so first-match is correct.
      const narrowed = canons.map((c) => narrowing.get(c)).find(Boolean);
      for (const name of extension.tools.keys()) {
        if (narrowed && !narrowed.has(name)) continue;
        if (disallowedSet?.has(name)) continue;
        keep.add(name);
      }
    }
    for (const name of EXCLUDED_TOOL_NAMES) keep.delete(name);
    // Injected tools are legitimately active for this agent — re-admit them so
    // the renarrow keeps them in the active set and beforeToolCall doesn't
    // block them. Already vetted against `disallowed_tools` by the caller,
    // which is the only place that knows which kind may be taken back.
    for (const name of readmitToolNames) keep.add(name);
    return keep;
  };

  // Names this agent selects explicitly: its built-ins, injected tools, and
  // `ext:foo/bar` narrowings. pi activates a named tool even when it is
  // `defaultActive: false`, as `--tools` does.
  const named = new Set([...toolNames, ...readmitToolNames, ...[...narrowing.values()].flatMap((s) => [...s])]);

  // Activate what pi itself would: only tools declared to the model (`direct`/
  // `model-only` exposure), and of those only named ones or ones not opted out
  // with `defaultActive: false`. `codemode`/`deferred` tools (pi's MCP tools by
  // default) stay undeclared until their extension or `tool_search` activates
  // them — so an already-active tool is kept, or turn_end would undo that.
  const renarrow = () => {
    const allowed = inScope();
    const current = session.getActiveToolNames();
    const active = new Set(current);
    const next = session
      .getAllTools()
      .filter(({ name, exposure = "direct" }) => {
        if (!allowed.has(name)) return false;
        if (active.has(name)) return true;
        if (exposure !== "direct" && exposure !== "model-only") return false;
        return named.has(name) || session.getToolDefinition(name)?.defaultActive !== false;
      })
      .map((t) => t.name);
    // setActiveToolsByName unconditionally rebuilds the system prompt, so skip
    // the no-op that steady-state turns would otherwise pay for every turn.
    if (next.length !== current.length || next.some((n, i) => n !== current[i])) {
      session.setActiveToolsByName(next);
    }
  };

  // Activate what registered during session_start (eager MCP servers); pi would
  // otherwise leave only its four default built-ins active at turn 1.
  renarrow();

  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") renarrow();
  });

  nestedCallGate.allows = (name) => inScope().has(name);

  installSessionToolController(session, {
    inScope,
    isHardLimited: ctx.isHardLimited,
    hardLimitAllowedTools: ctx.hardLimitAllowedTools,
  });
}

/** Set once the child's tool scope is installed; until then the gate admits everything. */
type NestedCallGate = { allows?: (name: string) => boolean };

/**
 * Inline extension that applies the subagent's tool scope to calls a tool makes
 * through `ctx.executeTool()` — codemode scripts calling MCP tools. pi runs those
 * past extensions' `tool_call` handlers only, never `agent.beforeToolCall`, and
 * every registered `codemode`/`deferred` tool is callable there whether or not
 * it is in scope.
 */
const SCOPE_GATE_NAME = "pi-subagents-scope";

function scopeGateExtension(gate: NestedCallGate): InlineExtension {
  return {
    name: SCOPE_GATE_NAME,
    hidden: true,
    factory: (ext) => {
      ext.on("tool_call", (event) =>
        gate.allows?.(event.toolName) === false
          ? { block: true, reason: `Tool "${event.toolName}" is not available to this subagent.` }
          : undefined,
      );
    },
  };
}

/** Default max turns. undefined = unlimited (no turn limit). */
let defaultMaxTurns: number | undefined;

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

/** Get the default max turns value. undefined = unlimited. */
export function getDefaultMaxTurns(): number | undefined { return defaultMaxTurns; }
/** Set the default max turns value. undefined or 0 = unlimited, otherwise minimum 1. */
export function setDefaultMaxTurns(n: number | undefined): void { defaultMaxTurns = normalizeMaxTurns(n); }

/**
 * The turn limit a run of `type` will actually enforce: an explicit value if the
 * caller supplied one, else the agent's own `max_turns`, else the project
 * default. `undefined` = unlimited.
 *
 * Exported because the widget's turn counter (`↻3≤20`) has to predict this
 * before the run starts, and a second copy of the expression would drift from
 * the one below that enforces it.
 */
export function resolveEffectiveMaxTurns(type: string, explicit?: number): number | undefined {
  return normalizeMaxTurns(explicit ?? getAgentConfig(type)?.maxTurns ?? defaultMaxTurns);
}

/**
 * Project default for `persist_session`, from the `rememberAgents` setting.
 * On by default: a persisted session is what lets `@handle` reopen an agent's
 * conversation after its record has been evicted, which is the whole point of
 * addressing an agent by a name that outlives one run. Per-agent frontmatter
 * still overrides it in both directions.
 */
let rememberAgents = true;

/** Whether subagent sessions are persisted by default. */
export function getRememberAgents(): boolean { return rememberAgents; }
/** Set whether subagent sessions are persisted by default. */
export function setRememberAgents(b: boolean): void { rememberAgents = b; }

/** Additional turns allowed after the soft limit steer message. */
let graceTurns = 5;

/** Get the grace turns value. */
export function getGraceTurns(): number { return graceTurns; }
/** Set the grace turns value (minimum 0). */
export function setGraceTurns(n: number): void { graceTurns = Math.max(0, n); }

/**
 * Try to find the right model for an agent type.
 * Priority: explicit option > config.model > parent model.
 */
export function resolveDefaultModel(
  parentModel: Model<any> | undefined,
  registry: { find(provider: string, modelId: string): Model<any> | undefined; getAvailable?(): Model<any>[] },
  configModel?: string,
): Model<any> | undefined {
  if (configModel) {
    const slashIdx = configModel.indexOf("/");
    if (slashIdx !== -1) {
      const provider = configModel.slice(0, slashIdx);
      const modelId = configModel.slice(slashIdx + 1);

      // Build a set of available model keys for fast lookup
      const available = registry.getAvailable?.();
      const availableKeys = available
        ? new Set(available.map((m: any) => `${m.provider}/${m.id}`))
        : undefined;
      const isAvailable = (p: string, id: string) =>
        !availableKeys || availableKeys.has(`${p}/${id}`);

      const found = registry.find(provider, modelId);
      if (found && isAvailable(provider, modelId)) return found;
    }
  }

  return parentModel;
}

/** Info about a tool event in the subagent. */
export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

export interface RunOptions {
  /** ExtensionAPI instance — used for pi.exec() instead of execSync. */
  pi: ExtensionAPI;
  /** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `Explore#a1b2c3d4`). */
  agentId?: string;
  model?: Model<any>;
  maxTurns?: number;
  /** Opt in to a hard tool ceiling at maxTurns; omitted keeps graceful soft-limit behavior. */
  hardLimit?: boolean;
  signal?: AbortSignal;
  /** Applies only when the agent file leaves `isolated:` unset — frontmatter is authoritative. */
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /**
   * Reopen this pi session file rather than starting an empty conversation.
   * `createAgentSession` seeds itself from whatever its SessionManager holds,
   * so pointing it at an existing file rehydrates that agent's history and the
   * prompt continues it. Everything else — tools, model, system prompt, turn
   * caps — is still resolved from the agent type, so the continuation runs
   * under the type's *current* definition, not the one the original run used.
   */
  resumeSessionFile?: string;
  /**
   * True when another agent spawned this one. Only top-level agents get a
   * handle, so only they can be reopened by name — which is the whole reason
   * `rememberAgents` persists a session at all. A nested run's transcript would
   * be unreachable by anything, so it stays in memory unless its own
   * frontmatter asks otherwise.
   */
  nested?: boolean;
  /**
   * True when a workflow run spawned this agent. Its final text is the value
   * `agent()` resolves to rather than a report a person reads, and the prompt
   * says so — but only when `structuredOutput` is unset, since that child
   * already has a `StructuredOutput` tool to answer through and two competing
   * "this is how you return your answer" instructions is worse than one.
   */
  workflow?: boolean;
  /** Override working directory (e.g. for worktree isolation). */
  cwd?: string;
  /**
   * Directory the worktree copy was created from. Set only when `cwd` points
   * into a worktree — the prompt then tells the agent to stay in the copy
   * instead of following the inherited parent prompt back to the main tree.
   */
  worktreeBase?: string;
  /**
   * Where .pi config is discovered (project extensions, skills, pi settings,
   * agent memory). Default: same as the working directory. The manager sets
   * this to the parent session's cwd when `SpawnOptions.cwd` points the
   * working directory elsewhere — the agent works *there* but carries the
   * parent project's config (the target's `.pi` extensions never execute).
   *
   * WARNING for future callers: if you pass `cwd` pointing at a directory the
   * user didn't open, you almost certainly must pass `configCwd` too —
   * omitting it makes the target's `.pi` extensions execute in this process.
   * (Worktree isolation is the one intentional exception: its copy IS the
   * parent's repo, so config resolving inside it is correct.)
   */
  configCwd?: string;
  /** Called on tool start/end with activity info. */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /**
   * Called once per assistant message_end with that message's usage delta.
   * Lets callers maintain a lifetime accumulator that survives compaction
   * (which replaces session.state.messages and resets stats-derived sums).
   *
   * `cost` is pi's own `usage.cost.total` for that message — priced from the
   * model's rates, so it is 0 (not missing) for a model pi has no pricing for.
   * We never price anything ourselves; every dollar figure this extension shows
   * or reports traces back to this field.
   */
  onAssistantUsage?: (usage: LifetimeUsage) => void;
  /**
   * Called when the session successfully compacts. `tokensBefore` is upstream's
   * pre-compaction context size estimate. Aborted compactions don't fire.
   */
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
  /**
   * Make this child report through a `StructuredOutput` tool built from this
   * schema, and put the validated payload on {@link RunResult.structuredJson}.
   *
   * Already compiled by the caller, so a schema this runtime cannot validate
   * fails at the call that wrote it rather than inside the child.
   */
  structuredOutput?: CompiledSchema;
  /** Runtime bridge for opt-in child-safe nested delegation. */
  nestedRuntime?: {
    manager: NestedAgentManager;
    parentAgentId: string;
    depth: number;
    maxSubagentDepth?: number;
  };
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
  /** True if the agent was hard-aborted (max_turns + grace exceeded). */
  aborted: boolean;
  /** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
  steered: boolean;
  /**
   * A failure message for the run's FINAL assistant turn, when that turn failed:
   * a provider error (stopReason "error"), or a "length" stop that produced no
   * text (a silent max-token death). pi resolves an exhausted-retries failure
   * normally instead of rejecting, so without this the manager would report such
   * a run as completed — with an empty result, or worse, an earlier turn's text
   * presented as the answer (#144). Undefined for a clean stop, or a "length"
   * stop that produced text (a legitimate truncated answer).
   */
  failure?: string;
  /**
   * The validated `StructuredOutput` payload as canonical JSON, when the caller
   * asked for a schema and the child produced one.
   *
   * Deliberately not folded into {@link responseText}: `record.result` picks up
   * a worktree branch note on the way out, which would leave the caller with
   * unparseable JSON, and merging the two would make "produced structured
   * output" indistinguishable from "happened to answer in JSON".
   */
  structuredJson?: string;
  /** Whether the extra structured-output prompt had to be sent. */
  structuredRetried?: boolean;
}

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(session: AgentSession) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    // message_start also fires for user and toolResult messages — resetting on
    // those would wipe assistant text already collected. Reset only when a new
    // ASSISTANT message begins, so getText() is the last assistant message's text.
    if (event.type === "message_start" && event.message.role === "assistant") {
      text = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
  });
  return { getText: () => text, unsubscribe };
}

/**
 * Get the last non-empty assistant text produced during THIS invocation.
 * `startIndex` is the message count captured before the prompt, so the walk-back
 * never crosses into a previous turn: on a resume whose new turn failed empty,
 * this returns "" instead of the prior turn's answer (#144). Defaults to 0 (a
 * fresh spawn, where the whole history belongs to this run).
 */
function getLastAssistantText(session: AgentSession, startIndex = 0): string {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Error message of THIS invocation's final assistant message, when that turn
 * failed. Two failure shapes, both keyed off how the final turn STOPPED:
 *   - stopReason "error": a provider failure pi resolved instead of rejecting
 *     (any text; partial output is surfaced separately).
 *   - stopReason "length" with NO text: a silent max-token death — the run hit
 *     the output-token ceiling before writing anything, which would otherwise
 *     land as a "completed" run with an empty result (the #144 symptom).
 * Everything else completes: a clean "stop"/"toolUse" final, and — crucially — a
 * "length" stop that DID produce text (a legitimate truncated-but-useful answer).
 * "aborted" is handled by the manager's abort flag / "stopped" guard, not here.
 * Bounded by `startIndex` (like the text fallback) so a resume that produced no
 * assistant message of its own never inherits a PRIOR turn's stop reason.
 */
function finalTurnError(session: AgentSession, startIndex = 0): string | undefined {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    if (msg.stopReason === "error") {
      return (msg as { errorMessage?: string }).errorMessage?.trim() || "provider error with no output";
    }
    if (msg.stopReason === "length" && !extractText(msg.content).trim()) {
      return "run hit the output token limit before producing any text";
    }
    return undefined;
  }
  return undefined;
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const onAbort = () => session.abort();
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function resolveConfiguredSessionDir(sessionDir: string | undefined, cwd: string): string | undefined {
  if (!sessionDir) return undefined;
  if (sessionDir === "~" || sessionDir.startsWith("~/")) return resolve(homedir(), sessionDir.slice(2));
  if (isAbsolute(sessionDir)) return sessionDir;
  return resolve(cwd, sessionDir);
}

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const config = getConfig(type);
  const agentConfig = getAgentConfig(type);

  // Resolve working directory: worktree override > parent cwd
  const effectiveCwd = options.cwd ?? ctx.cwd;
  // Filesystem work happens in effectiveCwd; config discovery in configCwd.
  // They differ only for SpawnOptions.cwd spawns (config stays with the parent).
  const configCwd = options.configCwd ?? effectiveCwd;

  const env = await detectEnv(options.pi, effectiveCwd);

  // Get parent system prompt for append-mode agents
  const parentSystemPrompt = ctx.getSystemPrompt();

  // Build prompt extras (memory, skill preloading)
  const extras: PromptExtras = {};
  if (options.worktreeBase) extras.worktreeBase = options.worktreeBase;
  if (options.workflow && !options.structuredOutput) extras.workflowChild = true;

  // Resolved here, not by each caller: mention and RPC spawns pass no `isolated`,
  // and the agent file's value must hold on every path.
  const isolated = agentConfig?.isolated ?? options.isolated;
  // Resolve extensions/skills: isolated overrides to false
  const extensions = isolated ? false : config.extensions;
  // Nulling excludes under isolated also suppresses the orphaned-exclude warning —
  // isolation is an intentional override, not a misconfiguration.
  const excludeExtensions = isolated ? undefined : config.excludeExtensions;
  const skills = isolated ? false : config.skills;

  // Skill preloading: when skills is string[], preload their content into prompt
  if (Array.isArray(skills)) {
    const loaded = preloadSkills(skills, configCwd);
    if (loaded.length > 0) {
      extras.skillBlocks = loaded;
    }
  }

  let toolNames = getToolNamesForType(type);

  // Persistent memory: detect write capability and branch accordingly.
  // Account for disallowedTools — a tool in the base set but on the denylist is not truly available.
  if (agentConfig?.memory) {
    const existingNames = new Set(toolNames);
    const denied = agentConfig.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;
    const effectivelyHas = (name: string) => existingNames.has(name) && !denied?.has(name);
    const hasWriteTools = effectivelyHas("write") || effectivelyHas("edit");

    if (hasWriteTools) {
      // Read-write memory: add any missing memory tool names (read/write/edit)
      const extraNames = getMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = buildMemoryBlock(agentConfig.name, agentConfig.memory, configCwd);
    } else {
      // Read-only memory: only add read tool name, use read-only prompt
      const extraNames = getReadOnlyMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = buildReadOnlyMemoryBlock(agentConfig.name, agentConfig.memory, configCwd);
    }
  }

  // Build system prompt from agent config
  let systemPrompt: string;
  if (agentConfig) {
    systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, parentSystemPrompt, extras);
  } else {
    // Unknown type fallback: spread the canonical general-purpose config (defensive —
    // unreachable in practice since index.ts resolves unknown types before calling runAgent).
    const fallback = DEFAULT_AGENTS.get("general-purpose");
    if (!fallback) throw new Error(`No fallback config available for unknown type "${type}"`);
    systemPrompt = buildAgentPrompt({ ...fallback, name: type }, effectiveCwd, env, parentSystemPrompt, extras);
  }

  // When skills is string[], we've already preloaded them into the prompt.
  // Still pass noSkills: true since we don't need the skill loader to load them again.
  const noSkills = skills === false || Array.isArray(skills);

  const agentDir = getAgentDir();

  // Extension loading:
  // - true  → all default-discovered extensions
  // - false → none (noExtensions)
  // - string[] → loader-level allowlist. Bare names keep the matching
  //   default-discovered extension; path entries load that extension fresh;
  //   "*" keeps all default-discovered extensions. Excluded extensions never
  //   bind handlers or register tools (their factory still runs once).
  //
  // Suppress AGENTS.md/CLAUDE.md and APPEND_SYSTEM.md — upstream's
  // buildSystemPrompt() re-appends both AFTER systemPromptOverride, which
  // would defeat prompt_mode: replace and isolated: true. Parent context, if
  // wanted, reaches the subagent via prompt_mode: append (parentSystemPrompt
  // is embedded in systemPromptOverride) or inherit_context (conversation).
  // `ext:` selectors from the `tools:` CSV narrow which extension tools surface to
  // the LLM. They do NOT control loading — `extensions:` is the sole authority for
  // which extensions load. `ext:foo` against an extension that `extensions:` excluded
  // is an orphan and warns after reload. `isolated` means no extension tools at all.
  const { extNames, narrowing } = parseExtSelectors(
    isolated ? [] : (agentConfig?.extSelectors ?? []),
  );
  const noExtensions = extensions === false;

  const extensionsSpec = Array.isArray(extensions)
    ? parseExtensionsSpec(extensions, configCwd)
    : undefined;
  const keepNames = extensionsSpec?.names ?? new Set<string>();
  // `exclude_extensions:` is a denylist applied AFTER the include set — exclude wins.
  // Plain canonical names only (case-insensitive). Note: excluded extensions'
  // factories still run once during reload() (see comment above) — exclusion
  // suppresses handler binding and tool registration; it is not a sandbox.
  const excludeNames = new Set((excludeExtensions ?? []).map((n) => n.toLowerCase()));
  const hasExcludes = excludeNames.size > 0;
  // The override filters loaded extensions down to `keepNames` minus `excludeNames`.
  // It's only needed when we're neither loading everything without excludes
  // (`extensions: true` or a `"*"` wildcard) nor nothing (`noExtensions`).
  const loadAll = extensions === true || extensionsSpec?.wildcard === true;
  const additionalExtensionPaths = extensionsSpec?.paths.length ? extensionsSpec.paths : undefined;
  // Pre-filter discovered set, captured by the override — the exclude-typo warning
  // must compare against this, not the surviving set (absence from survivors is
  // an exclude *succeeding*).
  let discoveredNames: Set<string> | undefined;
  const extensionsOverride: ((base: LoadExtensionsResult) => LoadExtensionsResult) | undefined =
    noExtensions || (loadAll && !hasExcludes)
      ? undefined
      : (base) => {
          discoveredNames = new Set(base.extensions.flatMap((e) => extensionCanonicalNames(e.path)));
          return {
            ...base,
            extensions: base.extensions.filter((e) => {
              if (e.path === `<inline:${SCOPE_GATE_NAME}>`) return true; // ours, not the agent's
              const canons = extensionCanonicalNames(e.path);
              if (canons.some((n) => excludeNames.has(n))) return false; // exclude wins
              return loadAll || canons.some((n) => keepNames.has(n));
            }),
          };
        };

  // The child inherits the parent's project-trust decision. pi's SettingsManager
  // defaults to trusted, so without this a subagent in a project the user declined
  // to trust would load its `.pi` extensions and settings, and pi's built-in MCP
  // would start the stdio servers in its `.pi/mcp.json`.
  const projectTrusted = ctx.isProjectTrusted();
  const settingsManager = SettingsManager.create(configCwd, agentDir, { projectTrusted });
  // That trust covers the parent's project (`configCwd`), not a directory a spawn
  // was sent into. The session answers `ctx.isProjectTrusted()` for its own cwd,
  // which pi's MCP uses to read `<cwd>/.pi/mcp.json` — so a cross-directory session
  // keeps the parent project's settings but reports its cwd as untrusted. The
  // loader keeps the trusted manager: it loads the parent project's extensions.
  const sessionSettingsManager =
    resolve(effectiveCwd) === resolve(configCwd)
      ? settingsManager
      : Object.assign(SettingsManager.create(configCwd, agentDir, { projectTrusted }), {
          isProjectTrusted: () => false,
        });
  const nestedCallGate: NestedCallGate = {};

  const loader = new DefaultResourceLoader({
    settingsManager,
    // pi's CLI hands its built-in extensions to the loader it builds; this one starts
    // with none. Forwarded as `builtin:` resources they load as in the main session —
    // default-on, disabled by `-builtin:<name>` in settings — and the per-agent
    // allowlist filters them like any other extension. pi's `llama.cpp` built-in is
    // CLI-only (not exported). Fresh factories per spawn: MCP state lives in the closure.
    extensionFactories: [
      { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
      { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
      { name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
      // Under `noExtensions` the static allowlist gates the registry itself.
      ...(noExtensions ? [] : [scopeGateExtension(nestedCallGate)]),
    ],
    // Mirrors pi's CLI: `--no-mcp` keeps MCP out of subagents too, and `--no-extensions`
    // keeps all the built-ins out. Discovered extensions still follow `extensions:`.
    disabledBuiltinExtensions: process.argv.some((a) => a === "--no-extensions" || a === "-ne")
      ? ["codemode", "tool-search", "mcp"]
      : process.argv.includes("--no-mcp")
        ? ["mcp"]
        : undefined,
    cwd: configCwd,
    agentDir,
    noExtensions,
    additionalExtensionPaths,
    extensionsOverride,
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await runInChildSessionContext(() => loader.reload());

  // Plain entries in `tools:` are expected to be built-in names (extension tools
  // go through `ext:`), so an unknown name there is unambiguously a typo. Previously
  // this produced a silently broken agent (#75) — pi-mono accepted the bogus name
  // into the allowlist, then dropped it at registration with no signal back.
  if (agentConfig?.builtinToolNames?.length) {
    const knownBuiltins = new Set(BUILTIN_TOOL_NAMES);
    for (const name of agentConfig.builtinToolNames) {
      if (!knownBuiltins.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `tools-error:tool "${name}" requested by agent "${type}" is not a known built-in`,
        });
      }
    }
  }

  // A subagent spawns mid-task, so a bad `extensions:`/`ext:` entry warns rather
  // than aborts. Two distinct misconfigurations to catch:
  //   - `extensions: [foo]` but no extension named foo was discovered (typo or
  //     path that failed to load — path entries fold their canonical name into
  //     `keepNames`, so this covers them too).
  //   - `tools: ext:foo` but foo isn't in the loaded set (because `extensions:`
  //     didn't include it). Since v0.9, `ext:` no longer pulls extensions in;
  //     loading is `extensions:`-authoritative.
  // An exclude_extensions: alongside extensions: false is contradictory — nothing
  // loads, so there is nothing to exclude.
  if (hasExcludes && noExtensions) {
    options.onToolActivity?.({
      type: "end",
      toolName: `extension-error:exclude_extensions has no effect for agent "${type}" — extensions: false loads nothing`,
    });
  }
  // Exclude typo check: compares against the PRE-filter discovered set (an excluded
  // name absent from the surviving set is the exclude working as intended). Also
  // flags path-like and "*" entries — excludes are plain names only.
  if (hasExcludes && discoveredNames) {
    for (const name of excludeNames) {
      if (!discoveredNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `extension-error:exclude_extensions: "${name}" for agent "${type}" did not match any discovered extension`,
        });
      }
    }
  }
  if (keepNames.size > 0 || extNames.size > 0) {
    const survivingNames = new Set(
      loader.getExtensions().extensions.flatMap((e) => extensionCanonicalNames(e.path)),
    );
    for (const name of keepNames) {
      if (!survivingNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: excludeNames.has(name)
            ? `extension-error:extension "${name}" is in both extensions: and exclude_extensions: for agent "${type}" — exclude wins`
            : `extension-error:extension "${name}" requested by agent "${type}" was not loaded`,
        });
      }
    }
    for (const name of extNames) {
      if (!survivingNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `extension-error:ext:${name} referenced by agent "${type}" but extension "${name}" is not loaded (check extensions:/exclude_extensions:)`,
        });
      }
    }
  }

  // Resolve model: explicit option > config.model > parent model
  const model = options.model ?? resolveDefaultModel(
    ctx.model, ctx.modelRegistry, agentConfig?.model,
  );

  // Resolve thinking level: explicit option > agent config > undefined (inherit)
  const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking;

  const disallowedSet = agentConfig?.disallowedTools
    ? new Set(agentConfig.disallowedTools)
    : undefined;

  // Nested delegation tools (opt-in, ownership-scoped). Empty unless the agent
  // set `allowed_subagents` and a nestedRuntime was provided — and never when
  // isolated. Their names collide with EXCLUDED_TOOL_NAMES by design, so the
  // scoping below re-admits them explicitly (registry deny + active-set narrow).
  const effectiveMaxDepth = options.nestedRuntime?.maxSubagentDepth ?? getMaxSubagentDepth();
  // At (or past) the cap this agent can never spawn, so it can never own a child
  // to fetch from or steer either — inject nothing rather than three tools whose
  // every call is an error. This is also what makes `maxSubagentDepth` 0/1 mean
  // "nesting off" instead of "nesting always fails".
  const nestedRuntime = options.nestedRuntime && options.nestedRuntime.depth < effectiveMaxDepth
    ? options.nestedRuntime
    : undefined;
  const nestedTools = agentConfig?.allowedSubagents && nestedRuntime && !isolated
    ? createNestedSubagentTools({
        manager: nestedRuntime.manager,
        pi: options.pi,
        parentAgentId: nestedRuntime.parentAgentId,
        depth: nestedRuntime.depth,
        maxSubagentDepth: effectiveMaxDepth,
        allowedSubagents: agentConfig.allowedSubagents,
        configCwd,
      })
    : [];
  const nestedToolNames = new Set(nestedTools.map(tool => tool.name));

  // The `agent({ schema })` contract: this child reports its answer by calling
  // StructuredOutput, and `structuredJson` below is what the caller reads. The
  // schema was already compiled by whoever asked for it, so a bad one failed
  // before any of this ran.
  const structuredCapture = options.structuredOutput ? createStructuredCapture() : undefined;
  const structuredTools = options.structuredOutput && structuredCapture
    ? [createStructuredOutputTool(options.structuredOutput, structuredCapture)]
    : [];
  const structuredToolNames = new Set(structuredTools.map(tool => tool.name));
  // Re-admitted together at every gate below. Kept as one set so a new injected
  // tool cannot be added to some of the three gates and forgotten at the rest.
  //
  // `disallowed_tools` is applied HERE rather than at the gates, because the two
  // kinds answer to it differently: a nested delegation tool is an opt-in the
  // agent's own frontmatter can take back, while StructuredOutput exists only
  // because this call asked for a schema — removing it would make the request
  // unsatisfiable by construction rather than merely restricted.
  const readmitToolNames = new Set([
    ...[...nestedToolNames].filter(name => !disallowedSet?.has(name)),
    ...structuredToolNames,
  ]);

  // ─── Tool scoping ───────────────────────────────────────────────────────
  //
  // Some extensions register their tools ASYNCHRONOUSLY, long after the
  // `loader.reload()` above: pi-mcp calls registerTool from `session_start`
  // (once its MCP servers connect), context-mode from `before_agent_start`.
  // That is deliberate on their part — eagerly spawning an MCP bridge during
  // extension discovery orphans child processes on pi's non-agent code paths
  // (--help, config, trust probing).
  //
  // So the tool set cannot be snapshotted here. pi's `allowedToolNames` gates
  // tool *registration* (`_refreshToolRegistry`'s `isAllowedTool`), not merely
  // the active set, and is frozen at construction — a name absent from the
  // snapshot is dropped forever, even once the tool actually registers (#125).
  //
  // Whenever extensions are in play we therefore:
  //   - leave `allowedToolNames` unset, so pi's live gate admits tools whenever
  //     they register;
  //   - express the name-stable, permanent part of the scope (our own
  //     orchestration tools, built-ins the agent didn't ask for, and
  //     `disallowedTools`) as `excludeTools`, which pi re-applies on every
  //     registry refresh;
  //   - enforce `ext:` narrowing on the ACTIVE set via the live `inScope()`
  //     predicate installed after bind — the active set is what the LLM sees,
  //     so a registry tool that is never activated is invisible and uncallable.
  //
  // `noExtensions`/`isolated` keeps the historical static allowlist: nothing
  // async can appear there, and a hard registry gate is the correct boundary.
  const builtinToolNameSet = new Set(toolNames);

  let sessionTools: string[] | undefined;
  let sessionExcludeTools: string[] | undefined;
  if (noExtensions) {
    // Strict allowlist: built-ins the agent asked for, plus any opt-in nested
    // tools (whose names would otherwise be dropped as EXCLUDED_TOOL_NAMES).
    sessionTools = [
      ...toolNames.filter(
        (t) => !EXCLUDED_TOOL_NAMES.includes(t) && !disallowedSet?.has(t),
      ),
      ...[...nestedToolNames].filter((t) => !disallowedSet?.has(t)),
      // Not filtered through `disallowedSet`, unlike the nested tools above:
      // the caller asked for a schema, and removing the only tool that can
      // satisfy it would make the request unsatisfiable by construction rather
      // than merely restricted.
      ...structuredToolNames,
    ];
  } else {
    // Deny the orchestration tools EXCEPT the nested ones this agent opted into —
    // those are injected as customTools and must survive the registry gate.
    const denyTools = new Set<string>(
      EXCLUDED_TOOL_NAMES.filter((t) => !nestedToolNames.has(t)),
    );
    // Keep only the built-ins the agent asked for — deny the rest.
    for (const name of BUILTIN_TOOL_NAMES) {
      if (!builtinToolNameSet.has(name)) denyTools.add(name);
    }
    if (disallowedSet) {
      // disallowed_tools wins even over an opt-in nested tool of the same name.
      // Not over StructuredOutput, though — see the allowlist branch above.
      for (const name of disallowedSet) {
        if (!structuredToolNames.has(name)) denyTools.add(name);
      }
    }
    sessionExcludeTools = [...denyTools];
  }

  const configuredSessionDir = resolveConfiguredSessionDir(agentConfig?.sessionDir, effectiveCwd);
  const defaultSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR ?? settingsManager.getSessionDir?.();
  // Frontmatter wins when it says anything; otherwise the project default,
  // which `rememberAgents` supplies for top-level agents only. Same precedence
  // as `outputTranscript`.
  const persistSession = agentConfig?.persistSession ?? (options.nested ? false : rememberAgents);
  const sessionManager = options.resumeSessionFile
    // Reopening an existing conversation: the file already carries its own
    // header (cwd, parent) and history, so none of the create-time options
    // apply. `sessionDir` still matters for a later /new or /branch off it.
    ? SessionManager.open(options.resumeSessionFile, configuredSessionDir ?? defaultSessionDir)
    : persistSession
      ? SessionManager.create(effectiveCwd, configuredSessionDir ?? defaultSessionDir, {
          // Optional metadata — it only nests the subagent under its spawner in
          // `/resume`. Until `rememberAgents` this ran solely for the rare
          // `persist_session: true` agent; now it runs for every spawn, so a
          // context without a session manager (a bare programmatic ctx) must
          // still persist rather than take the whole spawn down.
          parentSession: ctx.sessionManager?.getSessionFile?.(),
        })
      : SessionManager.inMemory(effectiveCwd);

  // Pi 0.80.8 replaced createAgentSession's modelRegistry option with
  // modelRuntime, but ExtensionContext still exposes only the registry facade.
  // Pass both so the full supported Pi range retains the parent's providers.
  const parentModelRuntime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
  const sessionOpts: Parameters<typeof createAgentSession>[0] & {
    modelRegistry: ExtensionContext["modelRegistry"];
    modelRuntime?: unknown;
  } = {
    cwd: effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager: sessionSettingsManager,
    modelRegistry: ctx.modelRegistry,
    // `as never` is what keeps this assignable across the supported Pi range:
    // pre-0.80.8 the field exists only via the `modelRuntime?: unknown` shim
    // above, while newer Pi types it as `ModelRuntime` — a shape an opaque
    // `unknown` read off the private facade field can never satisfy.
    ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime as never }),
    model,
    tools: sessionTools,
    customTools: [...nestedTools, ...structuredTools],
    resourceLoader: loader,
  };
  if (sessionExcludeTools) {
    sessionOpts.excludeTools = sessionExcludeTools;
  }
  if (thinkingLevel) {
    sessionOpts.thinkingLevel = thinkingLevel;
  }

  const { session } = await runInChildSessionContext(() => createAgentSession(sessionOpts));

  const baseSessionName = agentConfig?.name ?? type;
  session.setSessionName(
    options.agentId ? `${baseSessionName}#${options.agentId.slice(0, 8)}` : baseSessionName,
  );

  // Bind extensions so that session_start fires and extensions can initialize
  // (e.g. loading credentials, setting up state). Tool gating already happened
  // at session construction via the `tools:` allowlist above — no separate
  // post-bind filter is needed. All ExtensionBindings fields are optional.
  await session.bindExtensions({
    onError: (err) => {
      options.onToolActivity?.({
        type: "end",
        toolName: `extension-error:${err.extensionPath}`,
      });
    },
  });

  // max_turns is graceful by default. hardLimit removes tools at the ceiling,
  // leaving the model one tool-free turn to return its final answer (or only StructuredOutput if schema is set).
  let turnCount = 0;
  const maxTurns = resolveEffectiveMaxTurns(type, options.maxTurns);
  const hardLimit = options.hardLimit ?? agentConfig?.hardLimit ?? false;
  let limitReached = false;
  let aborted = false;
  const hardLimitAllowedTools = (): string[] =>
    structuredTools.length > 0 ? [STRUCTURED_OUTPUT_TOOL_NAME] : [];
  if (structuredCapture) {
    sessionStructuredCaptures.set(session, structuredCapture);
  }

  activeHardLimitControllers.set(session, {
    isHardLimited: () => limitReached && Boolean(hardLimit),
    hardLimitAllowedTools,
  });

  // With `allowedToolNames` unset, the registry is scoped by `excludeTools` but
  // the ACTIVE set still needs managing: pi activates only its four default
  // built-ins at turn 1, and `ext:` narrowing has no registry-level expression
  // (we can't deny the name of a tool that hasn't registered yet). Both are
  // handled below by re-deriving scope from the loader's live extension maps —
  // `registerTool` writes into those same maps, so late arrivals are judged too.
  if (!noExtensions) {
    installExtensionToolScope(session, {
      loader,
      toolNames,
      disallowedSet,
      extNames,
      narrowing,
      readmitToolNames,
      nestedCallGate,
      isHardLimited: () => limitReached && Boolean(hardLimit),
      hardLimitAllowedTools,
    });
  } else {
    installSessionToolController(session, {
      isHardLimited: () => limitReached && Boolean(hardLimit),
      hardLimitAllowedTools,
    });
  }

  options.onSessionCreated?.(session);

  let currentMessageText = "";
  const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
      options.onTurnEnd?.(turnCount);
      if (maxTurns != null) {
        if (aborted) {
          return;
        }
        if (turnCount >= maxTurns + graceTurns) {
          limitReached = true;
          aborted = true;
          session.abort();
        } else if (!limitReached && turnCount >= maxTurns) {
          limitReached = true;
          if (hardLimit) {
            const hardTools = hardLimitAllowedTools();
            session.setActiveToolsByName(hardTools);
            if (hardTools.length > 0) {
              session.steer("HARD LIMIT: Exploration tools disabled. Return your final answer now by calling StructuredOutput.");
            } else {
              session.steer("HARD LIMIT: Tools disabled. Return your final answer now without calling tools.");
            }
          } else {
            session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
          }
        } else if (hardLimit && limitReached) {
          // Extension scope listeners may re-activate tools at turn_end. Keep the
          // final-answer phase tool-free (or restricted to StructuredOutput) if the model emits another agentic turn.
          session.setActiveToolsByName(hardLimitAllowedTools());
        }
      }
    }
    if (event.type === "message_start") {
      currentMessageText = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      currentMessageText += event.assistantMessageEvent.delta;
      options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
    }
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({ type: "start", toolName: event.toolName });
    }
    if (event.type === "tool_execution_end") {
      options.onToolActivity?.({ type: "end", toolName: event.toolName });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const u = (event.message as any).usage;
      if (u) options.onAssistantUsage?.({
        input: u.input ?? 0,
        output: u.output ?? 0,
        cacheWrite: u.cacheWrite ?? 0,
        cacheRead: u.cacheRead ?? 0,
        cost: u.cost?.total ?? 0,
      });
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
  });

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  // Build the effective prompt: optionally prepend parent context
  let effectivePrompt = prompt;
  if (options.inheritContext) {
    const parentContext = buildParentContext(ctx);
    if (parentContext) {
      effectivePrompt = parentContext + prompt;
    }
  }

  // Boundary for the history fallback: only assistant text produced from here
  // on counts as this run's output (a fresh session, so usually 0).
  const startLen = session.messages.length;
  let structuredRetried = false;
  try {
    // A signal that fired before this point never calls the listener above, and
    // pi's `session.abort()` is a no-op until a run is active — so a child whose
    // parent is already gone is not prompted at all.
    if (options.signal?.aborted !== true) await session.prompt(effectivePrompt);

    // One more prompt when a schema was asked for and nothing usable came back
    // — the model answered in prose, or only ever called the tool invalidly.
    // Inside this `try`, so the turn tracking, the text collector and above all
    // the abort forwarding are still live: torn down first, a retry would be
    // unkillable.
    if (structuredCapture !== undefined && structuredCapture.json === undefined
      && !aborted && options.signal?.aborted !== true) {
      structuredRetried = true;
      if (hardLimit) {
        session.setActiveToolsByName([STRUCTURED_OUTPUT_TOOL_NAME]);
      }
      await session.prompt(structuredRetryPrompt(structuredCapture));
    }
  } finally {
    activeHardLimitControllers.delete(session);
    unsubTurns();
    collector.unsubscribe();
    cleanupAbort();
  }

  const responseText = collector.getText().trim() || getLastAssistantText(session, startLen);
  // A child asked for structured output that never gave any has failed, however
  // articulate its prose was. Reported through `failure` so it travels the same
  // path as a provider error rather than arriving as a successful empty answer.
  const structuredFailure = structuredCapture !== undefined && structuredCapture.json === undefined
    ? structuredCapture.lastError !== undefined
      ? `The agent's StructuredOutput call did not match the required schema: ${structuredCapture.lastError}`
      : "The agent did not report its answer through StructuredOutput."
    : undefined;
  return {
    responseText,
    session,
    aborted,
    steered: limitReached,
    failure: finalTurnError(session, startLen) ?? structuredFailure,
    ...(structuredCapture?.json !== undefined ? { structuredJson: structuredCapture.json } : {}),
    ...(structuredRetried ? { structuredRetried } : {}),
  };
}

/**
 * Send a new prompt to an existing session (resume).
 */
export async function resumeAgent(
  session: AgentSession,
  prompt: string,
  options: {
    maxTurns?: number;
    hardLimit?: boolean;
    onTurnEnd?: (turnCount: number) => void;
    onToolActivity?: (activity: ToolActivity) => void;
    onAssistantUsage?: (usage: LifetimeUsage) => void;
    onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ text: string; aborted?: boolean; steered?: boolean; failure?: string; structuredJson?: string }> {
  // If active tools were emptied (e.g. by hardLimit in a previous run), restore all
  // tools configured for this session so the resumed agent has tools available.
  if (session.getActiveToolNames && session.getAllTools) {
    const active = session.getActiveToolNames();
    const all = session.getAllTools();
    const isHardLimitedState = (active.length === 0 && all.length > 0) || (active.length === 1 && active[0] === STRUCTURED_OUTPUT_TOOL_NAME && all.length > 1);
    if (isHardLimitedState) {
      session.setActiveToolsByName(all.map((t) => t.name));
    }
  }

  // Boundary for the history fallback: the session already holds prior turns,
  // so only assistant text produced by THIS resume prompt counts as its output
  // — a failed resume must not surface the previous turn's answer (#144).
  const startLen = session.messages.length;
  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  let turnCount = 0;
  const maxTurns = normalizeMaxTurns(options.maxTurns);
  const hardLimit = options.hardLimit ?? false;
  let limitReached = false;
  let aborted = false;
  const structuredCapture = sessionStructuredCaptures.get(session);
  if (structuredCapture) {
    structuredCapture.called = false;
    structuredCapture.json = undefined;
    structuredCapture.lastError = undefined;
  }
  const hasStructuredTool = Boolean(
    structuredCapture ||
    session.getAllTools?.().some((t) => t.name === STRUCTURED_OUTPUT_TOOL_NAME),
  );
  const hardLimitAllowedTools = (): string[] =>
    hasStructuredTool ? [STRUCTURED_OUTPUT_TOOL_NAME] : [];

  activeHardLimitControllers.set(session, {
    isHardLimited: () => limitReached && Boolean(hardLimit),
    hardLimitAllowedTools,
  });

  installSessionToolController(session);
  const loopState = sessionLoopGuardStates.get(session);
  if (loopState) {
    loopState.consecutiveFailures.clear();
    loopState.pendingCalls.clear();
    loopState.blockedCalls.clear();
    loopState.blockedToolKeys.clear();
  }
  const unsubEvents = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
      options.onTurnEnd?.(turnCount);
      if (maxTurns != null) {
        if (aborted) {
          return;
        }
        if (turnCount >= maxTurns + graceTurns) {
          limitReached = true;
          aborted = true;
          session.abort();
        } else if (!limitReached && turnCount >= maxTurns) {
          limitReached = true;
          if (hardLimit) {
            const hardTools = hardLimitAllowedTools();
            session.setActiveToolsByName(hardTools);
            if (hardTools.length > 0) {
              session.steer("HARD LIMIT: Exploration tools disabled. Return your final answer now by calling StructuredOutput.");
            } else {
              session.steer("HARD LIMIT: Tools disabled. Return your final answer now without calling tools.");
            }
          } else {
            session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
          }
        } else if (hardLimit && limitReached) {
          session.setActiveToolsByName(hardLimitAllowedTools());
        }
      }
    }
    if (event.type === "tool_execution_start") options.onToolActivity?.({ type: "start", toolName: event.toolName });
    if (event.type === "tool_execution_end") options.onToolActivity?.({ type: "end", toolName: event.toolName });
    if (event.type === "message_end" && event.message.role === "assistant") {
      const u = (event.message as any).usage;
      if (u) options.onAssistantUsage?.({
        input: u.input ?? 0,
        output: u.output ?? 0,
        cacheWrite: u.cacheWrite ?? 0,
        cacheRead: u.cacheRead ?? 0,
        cost: u.cost?.total ?? 0,
      });
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
  });

  try {
    // Already aborted: not prompted, as in `runAgent`.
    if (options.signal?.aborted !== true) await session.prompt(prompt);
  } finally {
    activeHardLimitControllers.delete(session);
    collector.unsubscribe();
    unsubEvents();
    cleanupAbort();
  }

  return {
    text: collector.getText().trim() || getLastAssistantText(session, startLen),
    aborted,
    steered: limitReached,
    failure: finalTurnError(session, startLen),
    ...(structuredCapture?.json !== undefined ? { structuredJson: structuredCapture.json } : {}),
  };
}

/**
 * Send a steering message to a running subagent.
 * The message will interrupt the agent after its current tool execution.
 */
export async function steerAgent(
  session: AgentSession,
  message: string,
): Promise<void> {
  await session.steer(message);
}

/**
 * Get the subagent's conversation messages as formatted text.
 */
export function getAgentConversation(session: AgentSession): string {
  const parts: string[] = [];

  for (const msg of session.messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : extractText(msg.content);
      if (text.trim()) parts.push(`[User]: ${text.trim()}`);
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text) textParts.push(c.text);
        else if (c.type === "toolCall") toolCalls.push(`  Tool: ${(c as any).name ?? (c as any).toolName ?? "unknown"}`);
      }
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
      if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
    } else if (msg.role === "toolResult") {
      const text = extractText(msg.content);
      const truncated = text.length > 200 ? text.slice(0, 200) + "..." : text;
      parts.push(`[Tool Result (${msg.toolName})]: ${truncated}`);
    }
  }

  return parts.join("\n\n");
}
