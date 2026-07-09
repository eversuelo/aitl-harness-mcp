/**
 * Interactive control panel (`aitl interactive` / `aitl -i`).
 *
 * A dependency-free, readline-based supervisor TUI:
 *   - ↑/↓ + Enter to navigate actions, number keys as shortcuts.
 *   - Long-running services (MCP server, UI) run as tracked child processes with a
 *     live ●/○ status and a small rolling log panel.
 *   - `:` opens a command line so you can type any `aitl` subcommand
 *     (e.g. `search foo --project p`, `run "do a thing" --project p`).
 *
 * Everything is dispatched by re-spawning THIS CLI as a child, so the panel reuses the
 * exact command surface defined in `cli.ts` (no duplicated logic). Zero new deps → it
 * keeps working after `npm i -g`.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createInterface, emitKeypressEvents } from "node:readline";
import { councilFlow, delegateFlow, exportTasksFlow, planFlow, type TaskIO } from "./task.js";
import {
  availableHostNames,
  computeTaskActions,
  configuredProviderNames,
  detectAvailableHosts,
} from "./taskLogic.js";

const ESC = "\x1b";
const CLEAR = `${ESC}[2J${ESC}[H`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const GREEN = `${ESC}[32m`;
const GRAY = `${ESC}[90m`;
const CYAN = `${ESC}[36m`;
const RESET = `${ESC}[0m`;

const MAX_LOG_LINES = 8;

/** Re-spawn this CLI with the same runtime (works for `node dist/cli.js` and `tsx src/cli.ts`). */
function aitlSpawnArgs(extra: string[]): [string, string[]] {
  const entry = process.argv[1];
  const isTs = entry?.endsWith(".ts") ?? false;
  const hasTsxLoader = process.execArgv.some((a) => a.includes("tsx"));
  const loader = isTs && !hasTsxLoader ? ["--import", "tsx"] : [];
  return [process.execPath, [...process.execArgv, ...loader, entry, ...extra]];
}

interface Service {
  id: string;
  label: string;
  args: string[];
  child?: ChildProcess;
  status: "running" | "stopped" | "starting";
}

interface MenuItem {
  label: string;
  /** Leaf action. Omitted when the item opens a submenu. */
  run?: () => void | Promise<void>;
  /** When present, selecting this item descends into a submenu. */
  submenu?: () => MenuItem[];
}

interface MenuLevel {
  title: string;
  items: () => MenuItem[];
}

/** Split a command line into argv, respecting single/double quotes. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint: assignment-in-condition is the idiomatic regex-exec loop
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

export async function runInteractive(): Promise<void> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  const services: Service[] = [
    { id: "mcp", label: "MCP server", args: ["mcp"], status: "stopped" },
    { id: "ui", label: "UI (API + Vite)", args: ["ui"], status: "stopped" },
  ];
  const logs: string[] = [];
  let selected = 0;
  let mode: "menu" | "busy" = "menu";
  // Session default project, injected into command prefills so they never miss --project.
  let project = process.env.AITL_PROJECT?.trim() || "default";

  const pushLog = (line: string) => {
    for (const l of line.replace(/\r/g, "").split("\n")) {
      if (l.trim() === "") continue;
      logs.push(l);
    }
    while (logs.length > MAX_LOG_LINES) logs.shift();
    if (mode === "menu") render();
  };

  const startService = (svc: Service) => {
    if (svc.child) return;
    svc.status = "starting";
    const [cmd, args] = aitlSpawnArgs(svc.args);
    // detached puts the service in its own process group on POSIX, so stopping it can
    // kill the whole tree (the UI spawns a Vite grandchild that a plain kill() misses).
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      detached: process.platform !== "win32",
    });
    svc.child = child;
    svc.status = "running";
    const tag = `${GRAY}[${svc.id}]${RESET} `;
    child.stdout?.on("data", (d) => pushLog(`${tag}${String(d)}`));
    child.stderr?.on("data", (d) => pushLog(`${tag}${String(d)}`));
    child.on("exit", (code) => {
      svc.status = "stopped";
      svc.child = undefined;
      pushLog(`${tag}exited (code ${code ?? 0})`);
    });
    child.on("error", (err) => {
      svc.status = "stopped";
      svc.child = undefined;
      pushLog(`${tag}failed to start: ${err.message}`);
    });
    pushLog(`${tag}started: aitl ${svc.args.join(" ")}`);
    render();
  };

  /** Async tree-kill — used by the menu's "Stop" action so the UI stays responsive. */
  const stopService = (svc: Service) => {
    if (!svc.child) return;
    // Kill the whole tree on every platform (UI spawns a Vite grandchild).
    if (process.platform === "win32" && svc.child.pid) {
      spawn("taskkill", ["/pid", String(svc.child.pid), "/T", "/F"], { stdio: "ignore" });
    } else if (svc.child.pid) {
      try {
        process.kill(-svc.child.pid, "SIGTERM"); // negative pid = whole process group
      } catch {
        svc.child.kill();
      }
    }
  };

  /** Synchronous tree-kill — used on shutdown so children die BEFORE the parent exits. */
  const killServiceSync = (svc: Service) => {
    const child = svc.child;
    if (!child) return;
    svc.child = undefined;
    try {
      if (process.platform === "win32" && child.pid) {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
    } catch {
      // best-effort
    }
  };

  /** Suspend the menu's raw keyboard handling, run `fn`, then restore the menu.
   *  stdin is PAUSED while `fn` runs: an attached child shares this TTY fd, and a
   *  flowing parent stdin keeps read()ing it, stealing ~every other keystroke from
   *  the child (symptom: keys must be pressed twice inside `aitl chat`). */
  const suspend = async (fn: () => Promise<void>) => {
    mode = "busy";
    stdin.removeListener("keypress", onKeypress);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    try {
      await fn();
    } finally {
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.on("keypress", onKeypress);
      stdin.resume();
      mode = "menu";
      render();
    }
  };

  /** Run a one-shot `aitl` subcommand attached to the terminal (inherits stdio). */
  const runAttached = (args: string[]) =>
    suspend(
      () =>
        new Promise<void>((resolve) => {
          stdout.write(`${CLEAR}${CYAN}› aitl ${args.join(" ")}${RESET}\n\n`);
          const [cmd, spawnArgs] = aitlSpawnArgs(args);
          const child = spawn(cmd, spawnArgs, { stdio: "inherit", env: process.env });
          const returnToMenu = () => {
            stdout.write(`\n${DIM}— done. Press Enter to return to the menu —${RESET}`);
            stdin.once("data", () => resolve());
            stdin.resume(); // paused for the child's benefit; wake up for the Enter
          };
          child.on("exit", returnToMenu);
          child.on("error", (err) => {
            stdout.write(`\nfailed to spawn: ${err.message}\n`);
            returnToMenu();
          });
        }),
    );

  /** Prompt for an `aitl` command line, then run it attached. */
  const commandMode = (prefill = "") =>
    suspend(
      () =>
        new Promise<void>((resolve) => {
          const rl = createInterface({ input: stdin, output: stdout });
          stdout.write(`${CLEAR}${BOLD}Type an aitl command${RESET} ${DIM}(empty to cancel)${RESET}\n`);
          rl.question("aitl ", (answer) => {
            rl.close();
            const args = tokenize(answer.trim());
            if (!args.length) return resolve();
            const [cmd, spawnArgs] = aitlSpawnArgs(args);
            stdout.write(`\n${CYAN}› aitl ${args.join(" ")}${RESET}\n\n`);
            stdin.pause(); // readline resumed stdin; hand the TTY back to the child
            const child = spawn(cmd, spawnArgs, { stdio: "inherit", env: process.env });
            const returnToMenu = () => {
              stdout.write(`\n${DIM}— done. Press Enter to return to the menu —${RESET}`);
              stdin.once("data", () => resolve());
              stdin.resume();
            };
            child.on("exit", returnToMenu);
            child.on("error", (err) => {
              stdout.write(`\nfailed to spawn: ${err.message}\n`);
              returnToMenu();
            });
          });
          if (prefill) rl.write(prefill);
        }),
    );

  /** Prompt for the session default project (baked into command prefills). */
  const setProject = () =>
    suspend(
      () =>
        new Promise<void>((resolve) => {
          const rl = createInterface({ input: stdin, output: stdout });
          stdout.write(`${CLEAR}${BOLD}Default project${RESET} ${DIM}(empty to keep "${project}")${RESET}\n`);
          rl.question("project: ", (answer) => {
            rl.close();
            const p = answer.trim();
            if (p) project = p;
            resolve();
          });
        }),
    );

  let quitting = false;
  /** Synchronously stop every service. Idempotent — safe to call from any signal/exit. */
  const cleanup = () => {
    for (const svc of services) killServiceSync(svc);
  };

  const quit = (reason?: string) => {
    if (quitting) return;
    quitting = true;
    cleanup();
    if (reason) stdout.write(`${RESET}\n${DIM}${reason} — stopped servers.${RESET}\n`);
    else stdout.write(`${RESET}\n${DIM}Bye.${RESET}\n`);
    if (stdin.isTTY) stdin.setRawMode(false);
    process.exit(0);
  };

  // ── menu tree (submenus + "Go Back") ──────────────────────────────────────
  const servicesMenu = (): MenuItem[] =>
    services.map((svc) => ({
      label: svc.child ? `Stop ${svc.label}` : `Start ${svc.label}`,
      run: () => (svc.child ? stopService(svc) : startService(svc)),
    }));
  const chatMenu = (): MenuItem[] => [
    { label: "Chat (auto provider + fallback)", run: () => runAttached(["chat", "--project", project]) },
    { label: "Chat con --ask (aprobar tools)", run: () => runAttached(["chat", "--project", project, "--ask"]) },
    { label: "Chat con MCP tools (.mcp.json)", run: () => runAttached(["chat", "--project", project, "--mcp"]) },
    { label: "Chat: anthropic", run: () => runAttached(["chat", "--project", project, "--model", "anthropic"]) },
    { label: "Chat: openrouter", run: () => runAttached(["chat", "--project", project, "--model", "openrouter"]) },
    { label: "Chat: lmstudio (local)", run: () => runAttached(["chat", "--project", project, "--model", "lmstudio"]) },
    { label: "Modelos configurados", run: () => runAttached(["models"]) },
  ];
  const memoryMenu = (): MenuItem[] => [
    { label: "Search memory", run: () => commandMode(`search --project ${project} `) },
    { label: "Run task", run: () => commandMode(`run --project ${project} "`) },
    { label: "Run on host", run: () => commandMode(`run-host --project ${project} --host claude-code "`) },
    { label: "Orchestrate task", run: () => commandMode(`orchestrate --project ${project} "`) },
  ];
  const databaseMenu = (): MenuItem[] => [
    { label: "Check DB", run: () => runAttached(["check-db"]) },
    { label: "Init DB", run: () => runAttached(["init-db"]) },
  ];
  const configMenu = (): MenuItem[] => [
    { label: "Config: show", run: () => runAttached(["config", "show"]) },
    { label: "Config: path", run: () => runAttached(["config", "path"]) },
  ];

  // ── Task branch (P9): Planear / Delegar / Council over a user-typed task ────
  const TASK_TAG = `${GRAY}[task]${RESET} `;

  /** Run an in-process Task flow under suspend(), with a readline-backed TaskIO. */
  const runTaskFlow = (flow: (io: TaskIO) => Promise<void>) =>
    suspend(async () => {
      stdout.write(CLEAR);
      const rl = createInterface({ input: stdin, output: stdout });
      const io: TaskIO = {
        write: (text) => void stdout.write(text),
        question: (q) => new Promise<string>((resolve) => rl.question(q, resolve)),
      };
      try {
        await flow(io);
      } catch (err) {
        stdout.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
      } finally {
        rl.close();
      }
      await new Promise<void>((resolve) => {
        stdout.write(`\n${DIM}— done. Press Enter to return to the menu —${RESET}`);
        stdin.once("data", () => resolve());
        stdin.resume(); // paused by suspend(); wake up for the Enter
      });
    });

  /** Availability is re-probed on every render, so plugging in a host (or exporting an
   *  AITL_HOST_CMD_* override) enables the action without reopening the panel. */
  const taskMenu = (): MenuItem[] => {
    const hosts = detectAvailableHosts();
    const actions = computeTaskActions({
      hosts: availableHostNames(hosts),
      providers: configuredProviderNames(),
    });
    const gated = (
      label: string,
      a: { enabled: boolean; reason?: string },
      run: () => void,
    ): MenuItem =>
      a.enabled
        ? { label, run }
        : {
            label: `${GRAY}${label}${RESET} ${DIM}✗ ${a.reason}${RESET}`,
            run: () => pushLog(`${TASK_TAG}${label}: ${a.reason}`),
          };
    return [
      gated("Planear (SDD preview → confirmar persistencia)", actions.plan, () =>
        void runTaskFlow((io) => planFlow(project, io)),
      ),
      gated("Delegar (run-host sobre un host disponible)", actions.delegate, () =>
        void runTaskFlow((io) => delegateFlow(project, io, hosts)),
      ),
      gated("Council (deliberar el plan entre agentes)", actions.council, () => {
        const seats = actions.council.seats;
        if (seats) void runTaskFlow((io) => councilFlow(project, io, seats, hosts));
      }),
      // Always available: only needs Mongo, and the flow degrades with a warning.
      {
        label: "Exportar tareas (markdown → <dir>/tasks)",
        run: () => void runTaskFlow((io) => exportTasksFlow(project, io)),
      },
    ];
  };

  let coordPollInFlight = false;
  /** Entering the Task branch (spec P9.1): make sure the MCP service is up and surface
   *  pending coordination events — both best-effort and NON-blocking (they land in the
   *  rolling log panel; `coord poll` keeps its own incremental cursor and exits 0). */
  const enterTaskBranch = (): void => {
    if (currentLevel().title === "Task") return;
    const mcp = services.find((s) => s.id === "mcp");
    if (mcp && !mcp.child) {
      pushLog(`${TASK_TAG}MCP server apagado — arrancándolo (best-effort)…`);
      startService(mcp);
    }
    if (!coordPollInFlight) {
      coordPollInFlight = true;
      const [cmd, args] = aitlSpawnArgs(["coord", "poll", "--project", project, "--quiet"]);
      const tag = `${GRAY}[coord]${RESET} `;
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
      child.stdout?.on("data", (d) => pushLog(`${tag}${String(d)}`));
      child.stderr?.on("data", (d) => pushLog(`${tag}${String(d)}`));
      child.on("error", (err) => {
        coordPollInFlight = false;
        pushLog(`${tag}poll falló: ${err.message}`);
      });
      child.on("exit", () => {
        coordPollInFlight = false;
      });
    }
    stack.push({ title: "Task", items: taskMenu });
    selected = 0;
    render();
  };

  const rootLevel: MenuLevel = {
    title: "interactive",
    items: () => [
      { label: "Task (t) ▸", run: enterTaskBranch },
      { label: "Chat (c) ▸", submenu: chatMenu },
      { label: "Services ▸", submenu: servicesMenu },
      { label: "Memory ▸", submenu: memoryMenu },
      { label: "Database ▸", submenu: databaseMenu },
      { label: "Config ▸", submenu: configMenu },
      { label: `Project: ${project} (p)`, run: setProject },
      { label: "Type a command (:)", run: () => commandMode() },
      { label: "Quit (q)", run: quit },
    ],
  };

  // Navigation stack: the last level is the one on screen. Back = pop.
  const stack: MenuLevel[] = [rootLevel];
  const currentLevel = (): MenuLevel => stack[stack.length - 1];

  /** Current level's items, with a "← Back" entry appended inside any submenu. */
  const currentItems = (): MenuItem[] => {
    const items = currentLevel().items();
    return stack.length > 1 ? [...items, { label: `${GRAY}← Back${RESET}`, run: goBack }] : items;
  };

  /** Enter a submenu, or run a leaf action. */
  const enter = (item: MenuItem | undefined): void => {
    if (!item) return;
    if (item.submenu) {
      stack.push({ title: item.label.replace(/\s*▸\s*$/, ""), items: item.submenu });
      selected = 0;
      render();
    } else {
      void item.run?.();
    }
  };

  /** Go back one menu level. No-op at the root. */
  const goBack = (): void => {
    if (stack.length <= 1) return;
    stack.pop();
    selected = 0;
    render();
  };

  function render(): void {
    const items = currentItems();
    if (selected >= items.length) selected = Math.max(0, items.length - 1);
    const lines: string[] = [];
    const crumb = stack.map((l) => l.title).join(`${RESET}${GRAY} › ${BOLD}`);
    lines.push(`${BOLD}AITL · ${crumb}${RESET}   ${DIM}project: ${project}${RESET}`, "");
    for (const svc of services) {
      const dot = svc.status === "running" ? `${GREEN}●${RESET}` : `${GRAY}○${RESET}`;
      lines.push(`  ${dot} ${svc.label.padEnd(18)} ${DIM}${svc.status}${RESET}`);
    }
    lines.push(`${GRAY}  ${"─".repeat(40)}${RESET}`);
    items.forEach((it, i) => {
      const cursor = i === selected ? `${CYAN}>${RESET}` : " ";
      const label = i === selected ? `${BOLD}${it.label}${RESET}` : it.label;
      lines.push(` ${cursor} ${label}`);
    });
    if (logs.length) {
      lines.push(`${GRAY}  ${"─".repeat(40)}${RESET}`, `${DIM}  recent output${RESET}`);
      for (const l of logs) lines.push(`  ${l.replace(/\n$/, "")}`);
    }
    lines.push(
      "",
      `${DIM}  ↑↓ navigate · Enter select · 1-9 jump${stack.length > 1 ? " · Esc/← back" : ""} · t task · c chat · p project · : command · q quit${RESET}`,
    );
    stdout.write(CLEAR + lines.join("\n") + "\n");
  }

  function onKeypress(_str: string, key: { name?: string; ctrl?: boolean; sequence?: string }): void {
    if (mode !== "menu") return;
    const items = currentItems();
    if (key.ctrl && key.name === "c") return quit();
    switch (key.name) {
      case "up":
        selected = (selected - 1 + items.length) % items.length;
        return render();
      case "down":
        selected = (selected + 1) % items.length;
        return render();
      case "return":
        return enter(items[selected]);
      case "escape":
      case "backspace":
        return goBack();
      case "left":
        if (stack.length > 1) return goBack();
        break;
      case "q":
        return quit();
      default:
        break;
    }
    if (key.sequence === ":") return void commandMode();
    if (key.sequence === "t") return enterTaskBranch();
    if (key.sequence === "p") return void setProject();
    if (key.sequence === "c") return void runAttached(["chat", "--project", project]);
    if (key.sequence && /^[1-9]$/.test(key.sequence)) {
      const idx = Number(key.sequence) - 1;
      if (idx < items.length) {
        selected = idx;
        enter(items[idx]);
      }
    }
  }

  if (!stdin.isTTY) {
    stdout.write("Interactive mode requires a TTY. Run `aitl <command>` directly instead.\n");
    process.exit(1);
  }

  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("keypress", onKeypress);

  // Shut down (and stop all child servers) when the terminal closes or we're asked to:
  //   SIGINT  → Ctrl-C; SIGTERM → kill/`taskkill`; SIGHUP → terminal/console window closed.
  process.on("SIGINT", () => quit("SIGINT"));
  process.on("SIGTERM", () => quit("SIGTERM"));
  process.on("SIGHUP", () => quit("SIGHUP"));
  if (process.platform === "win32") process.on("SIGBREAK", () => quit("SIGBREAK"));
  // Last-resort backstop: if the process exits for any other reason, still kill children.
  process.on("exit", cleanup);
  render();

  // Keep the event loop alive until the user quits.
  await new Promise<void>(() => {});
}
