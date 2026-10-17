/**
 * splash-m1 auto-serve
 * --------------------
 * Makes omp self-sufficient for the local Splash M1 model server:
 *
 *   1. On session start (and before each prompt), probe <url>/ready.
 *   2. If the server is not up, spawn:  splash serve --model <model>  (detached)
 *   3. Poll /ready in the background and show progress on the status line;
 *      when it becomes ready, clear the status and notify.
 *   4. Before a prompt is dispatched, wait (bounded) for readiness so the
 *      first request does not hit a server that is still loading.
 *
 * Splash semantics this relies on (verified against 1.3.2-m1.1):
 *   - The port is bound before the model loads but the socket only starts
 *     accepting after the runtime is ready, so a loading server answers
 *     ECONNREFUSED.
 *   - Once accepting, /ready is 200 iff ready, 503 while recovering.
 *   - Idle weight release keeps /ready at 200; the next request restores
 *     the weights automatically, so no special handling is needed.
 *   - A duplicate `serve` on an occupied port fails fast at bind time.
 *
 * Configuration (environment variables, read at omp start):
 *   SPLASH_M1_URL       server base URL          (default http://127.0.0.1:8000)
 *   SPLASH_M1_MODEL     model for `serve`        (default mlx-community/Qwen3.8-27B-4bit)
 *   SPLASH_M1_PROVIDERS comma-separated provider names in models.yml that this
 *                       extension manages     (default splash-m1)
 *   SPLASH_M1_BIN       explicit splash binary path (default: `which splash-m1` / `which splash`)
 *   SPLASH_M1_DISABLE=1  turn the extension off
 *
 * The spawned server keeps running after omp exits (detached); stop it with
 * Ctrl+C in its own terminal, `pkill -f 'server\.server .*--port <port>'`,
 * or the /v1/memory/release + process exit of your choosing.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// --- configuration ---------------------------------------------------------

const DISABLED = process.env.SPLASH_M1_DISABLE === "1";
const BASE_URL = (process.env.SPLASH_M1_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
const MODEL = process.env.SPLASH_M1_MODEL ?? "mlx-community/Qwen3.8-27B-4bit";
const PROVIDERS: Record<string, true> = Object.fromEntries(
  (process.env.SPLASH_M1_PROVIDERS ?? "splash-m1").split(",").map((s) => s.trim()).filter(Boolean).map((s) => [s, true]),
);

let PORT = 8000;
try {
  const u = new URL(BASE_URL);
  PORT = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
} catch {
  PORT = 8000;
}

const READY_URL = `${BASE_URL}/ready`;
const SHORT_NAME = MODEL.split("/").pop() ?? MODEL;
const PROBE_TIMEOUT_MS = 2000;
const POLL_MS = 2000;
const MAX_WAIT_MS = 15 * 60_000; // background poller cap
const GATE_MS = 22_000; // prompt gate; stays under the 30s handler budget
const STATUS_KEY = "splash";
const LOG_PATH = path.join(os.tmpdir(), `splash-m1-serve-${PORT}.log`);

// --- module state (shared across sessions of one omp process) --------------

const children = new Set<ChildLike>();
let pollTimer: TimerHandle | null = null;
let pollCtx: CtxLike | null = null;
let announced = false;

type TimerHandle = unknown; // opaque handle from ctx.setTimeout or global setTimeout

interface ChildLike {
  pid?: number;
  on: (event: string, cb: (...a: unknown[]) => void) => unknown;
  unref: () => void;
}

interface UiLike {
  setStatus?: (key: string, text: string) => unknown;
  notify?: (message: string, kind?: string) => unknown;
}

interface CtxLike {
  ui?: UiLike;
  agent?: { kind?: string; [k: string]: unknown };
  model?: { provider?: string; id?: string };
  models?: { current?: () => { provider?: string; id?: string } };
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

interface PiLike {
  on: (event: string, handler: (event: unknown, ctx: CtxLike) => void | Promise<void>) => void;
  setLabel?: (label: string) => void;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}

let piRef: PiLike | null = null;

function log(level: "info" | "warn" | "error", msg: string): void {
  try {
    piRef?.logger?.[level]?.(`splash-m1 auto-serve: ${msg}`);
  } catch {
    // never let logging break the session
  }
}

// --- primitives -------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function probe(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(READY_URL, { signal: ctrl.signal });
      return res.status === 200;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false; // connection refused / timeout / non-200 => not ready
  }
}

/**
 * Is a splash serve process for this port running (even while still loading)?
 * Matches the python launcher's command line:  ... -m server.server ... --port N
 * (the optional .js admits same-named JS/TS launcher variants).
 */
function serverProcessRunning(): boolean {
  try {
    const r = spawnSync("pgrep", ["-f", `server\\.server(\\.js)? .*--port ${PORT}( |$)`], {
      encoding: "utf8",
      timeout: 2000,
    });
    return r.status === 0 && (r.stdout ?? "").trim().length > 0;
  } catch {
    return false;
  }
}

let resolvedBin: string | null = null;
function splashBin(): string {
  if (resolvedBin) return resolvedBin;
  const override = process.env.SPLASH_M1_BIN;
  if (override) {
    resolvedBin = override;
    return override;
  }
  for (const name of ["splash-m1", "splash"]) {
    try {
      const r = spawnSync("which", [name], { encoding: "utf8", timeout: 2000 });
      const out = (r.stdout ?? "").trim().split("\n")[0];
      if (r.status === 0 && out) {
        resolvedBin = out;
        return out;
      }
    } catch {
      // keep looking
    }
  }
  resolvedBin = "splash-m1"; // let PATH decide; a missing binary surfaces as a spawn error
  return resolvedBin;
}

function serveArgs(): string[] {
  const args = ["serve", "--model", MODEL];
  if (PORT !== 8000) args.push("--port", String(PORT));
  return args;
}

/**
 * Surface a startup failure in the UI, but only when no server process
 * remains: a second concurrent spawn can fail at bind while the first keeps
 * loading, and an externally running server must never be reported as failed.
 */
function onChildGone(reason: string): void {
  if (children.size > 0 || serverProcessRunning() || announced) return;
  const msg = `splash server ${reason} (log: ${LOG_PATH})`;
  log("error", msg);
  try {
    pollCtx?.ui?.setStatus?.(STATUS_KEY, `splash: ${reason}`);
  } catch {
    // ignore
  }
  try {
    pollCtx?.ui?.notify?.(msg, "error");
  } catch {
    // ignore
  }
}

/** Spawn a detached `splash serve`. Returns true when a spawn was initiated. */
function startServer(): boolean {
  if (children.size > 0) return false;
  if (serverProcessRunning()) return false;
  const bin = splashBin();
  let fd: number | "ignore" = "ignore";
  try {
    fd = fs.openSync(LOG_PATH, "a");
    fs.writeSync(fd, `\n--- ${new Date().toISOString()} omp spawned: ${bin} ${serveArgs().join(" ")} (log appends here)\n`);
  } catch {
    fd = "ignore";
  }
  try {
    const c = spawn(bin, serveArgs(), {
      detached: true,
      stdio: ["ignore", fd, fd],
    }) as ChildLike;
    if (typeof fd === "number") {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    children.add(c);
    c.on("error", (err) => {
      children.delete(c);
      onChildGone(`failed to start: ${err instanceof Error ? err.message : String(err)}`);
    });
    c.on("exit", (code, signal) => {
      children.delete(c);
      log("warn", `splash server process exited (code=${code ?? "null"} signal=${signal ?? "none"})`);
      onChildGone(`exited during startup (code=${code ?? "null"}${signal ? ` signal=${signal}` : ""})`);
    });
    c.unref();
    log("info", `spawned ${bin} ${serveArgs().join(" ")} (pid ${c.pid ?? "?"})`);
    return true;
  } catch (err) {
    onChildGone(`spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Idempotent "make sure a server is coming up" step. */
function ensureServer(): void {
  if (children.size > 0) return;
  if (serverProcessRunning()) return;
  startServer();
}

// --- UI helpers (all no-op safe) --------------------------------------------

function setStatus(ctx: CtxLike | null, text: string): void {
  try {
    ctx?.ui?.setStatus?.(STATUS_KEY, text);
  } catch {
    // ignore
  }
}

function notify(ctx: CtxLike | null, message: string, kind = "info"): void {
  try {
    ctx?.ui?.notify?.(message, kind);
  } catch {
    // ignore
  }
}

// --- background poller ------------------------------------------------------

function stopPoller(): void {
  if (pollTimer !== null) {
    const handle = pollTimer;
    pollTimer = null;
    try {
      if (pollCtx?.clearTimeout) pollCtx.clearTimeout(handle);
      else globalThis.clearTimeout(handle as never);
    } catch {
      // ignore
    }
  }
}

function startPoller(ctx: CtxLike): void {
  stopPoller();
  pollCtx = ctx;
  announced = false;
  const started = Date.now();
  const tick = async () => {
    pollTimer = null;
    try {
      if (await probe()) {
        if (!announced) {
          announced = true;
          setStatus(ctx, "");
          notify(ctx, `splash ${SHORT_NAME} is ready`);
          log("info", `model ready after ${Math.round((Date.now() - started) / 1000)}s`);
        }
        return; // done; the model now serves (or auto-restores after idle release)
      }
      if (children.size === 0 && !serverProcessRunning() && !announced) {
        onChildGone("exited during startup");
        return;
      }
      if (Date.now() - started > MAX_WAIT_MS) {
        setStatus(ctx, "splash: not ready after 15m");
        notify(ctx, "splash model still not ready after 15 minutes — check the log", "error");
        return;
      }
      setStatus(ctx, `splash: loading ${SHORT_NAME}… ${Math.round((Date.now() - started) / 1000)}s`);
    } catch {
      // keep polling; a probe failure is not fatal
    }
    const t = ctx.setTimeout ? ctx.setTimeout(() => void tick(), POLL_MS) : setTimeout(() => void tick(), POLL_MS);
    pollTimer = t;
  };
  void tick();
}

// --- prompt gate -------------------------------------------------------------

/**
 * Wait (bounded) for readiness before a prompt is dispatched. The extension
 * handler budget is 30s, so this stays well under it; if the model is not
 * ready in time the prompt proceeds and fails with a clear connection error,
 * while the background poller keeps going and the next attempt succeeds.
 */
async function waitForReady(ctx: CtxLike): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    if (await probe()) {
      setStatus(ctx, "");
      return true;
    }
    ensureServer();
    if (Date.now() - started > GATE_MS) {
      setStatus(ctx, "splash: model not ready — send your prompt again");
      return false;
    }
    setStatus(ctx, "splash: waiting for model…");
    await sleep(1500);
  }
}

// --- provider gating ----------------------------------------------------------

function managesSessionModel(ctx: CtxLike | null): boolean {
  if (Object.keys(PROVIDERS).length === 0) return true;
  const m = ctx?.models?.current?.() ?? ctx?.model;
  if (!m) return true; // cannot tell — err on the side of the user's main workflow
  if (typeof m.provider === "string" && PROVIDERS[m.provider]) return true;
  if (typeof m.id === "string") {
    const prefix = m.id.split("/")[0];
    if (prefix && PROVIDERS[prefix]) return true;
  }
  return false;
}

// --- factory ------------------------------------------------------------------

export default function splashM1AutoServe(pi: PiLike): void {
  if (DISABLED) return;
  piRef = pi;
  pi.setLabel?.("splash-m1 auto-serve");
  log("info", `enabled · ${BASE_URL} · ${MODEL} (port ${PORT})`);

  // Awaited by the host: the fast path is a single /ready probe.
  pi.on("session_start", async (_event, ctx) => {
    try {
      if (!managesSessionModel(ctx)) return;
      if (await probe()) {
        setStatus(ctx, "");
        return;
      }
      ensureServer();
      setStatus(ctx, "splash: server not ready");
      startPoller(ctx);
    } catch (err) {
      log("error", `session_start: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Awaited by the host: this is what actually holds the first provider
  // request until the model can serve (bounded, under the handler budget).
  pi.on("before_agent_start", async (_event, ctx) => {
    // Subagent sessions fail fast on a missing server; the main session
    // drives recovery. Avoids N parallel bounded waits.
    if (ctx?.agent?.kind === "sub") return;
    if (!managesSessionModel(ctx)) return;
    try {
      if (await probe()) {
        setStatus(ctx, "");
        return;
      }
      const ready = await waitForReady(ctx);
      if (!ready) {
        setStatus(ctx, "splash: model not ready — send your prompt again");
        log("warn", "prompt proceeded before the model was ready");
      }
    } catch (err) {
      log("error", `before_agent_start: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    try {
      if (managesSessionModel(ctx)) setStatus(ctx, "");
    } catch {
      // ignore
    }
    // The server intentionally outlives the session.
  });
}
