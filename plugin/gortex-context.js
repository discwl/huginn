/**
 * Gortex context bridge and index-readiness gate for OpenCode.
 *
 * Gortex ships no OpenCode hook adapter — its `opencode` integration only
 * writes the MCP stanza and the AGENTS.md rule block. This plugin supplies the
 * missing hook layer so OpenCode gets the same graph enrichment Codex and
 * Copilot CLI receive, plus the same readiness gate.
 *
 * Gortex speaks the Claude hook protocol, so events are translated into that
 * shape and OpenCode's lowercase tool names are mapped to Claude's.
 *
 *   chat.message                       -> readiness gate (waits out a first index)
 *   experimental.chat.system.transform -> SessionStart orientation
 *   tool.execute.after                 -> PostToolUse enrichment on search/read tools
 *
 * `system.transform` runs once per LLM request, not once per session, and the
 * system array is rebuilt every time. OpenCode also issues a separate
 * title-generation request on a small model. So the orientation text is cached
 * per session but re-pushed on every request; caching the *injection* instead
 * lets the title request swallow it and starves the real agent.
 *
 * Every failure path is swallowed: a missing binary, a stopped daemon, or a slow
 * call degrades to "no extra context" rather than breaking the session.
 */

const GORTEX_TIMEOUT_MS = 10000;

// Registration and indexing are separate states, and Paseo starts an agent as
// soon as its worktree exists. The gate is what stops the model working from an
// empty graph; the shared PowerShell module is the single implementation of it.
const GATE_SCRIPT = `${process.env.USERPROFILE ?? process.env.HOME}\\.gortex\\agent-hooks\\gortex-readiness.ps1`;
const GATE_TIMEOUT_MS = 31 * 60 * 1000;

// Gortex's Claude handler matches on Claude's capitalised tool names.
const TOOL_NAME_MAP = {
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  read: "Read",
  edit: "Edit",
  write: "Write",
  list: "Glob",
};

const ENRICHED_TOOLS = new Set(["bash", "grep", "glob", "read"]);

// Gortex resolves "is this file indexed?" by comparing the incoming path
// against the tracked-repo root as raw bytes, and it only normalises a path on
// its relative branch. On Windows a forward-slash absolute path, an MSYS
// `/c/...` path, or a case difference all miss a backslash-canonical root and
// come back "not indexed", so the enrichment is dropped. config.yaml holds the
// canonical spelling, so it is the reference for the rewrite.
const CONFIG_PATH = `${process.env.USERPROFILE ?? process.env.HOME}\\.gortex\\config.yaml`;

let trackedRootsCache = null;

function trackedRoots() {
  if (trackedRootsCache) return trackedRootsCache;

  trackedRootsCache = [];
  try {
    const text = require("node:fs").readFileSync(CONFIG_PATH, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*-?\s*path:\s*['"]?([^'"#]+?)['"]?\s*$/);
      if (match) trackedRootsCache.push(match[1].replace(/[\\/]+$/, ""));
    }
    // Longest first, so a repo nested inside another re-cases against its own
    // root, matching the longest-match rule the daemon applies.
    trackedRootsCache.sort((a, b) => b.length - a.length);
  } catch {
    // An unreadable registry only costs the case pass; separators still get fixed.
  }
  return trackedRootsCache;
}

function canonicalPath(value) {
  if (typeof value !== "string" || !value) return value;

  // Only drive-absolute runs are touched. A bare leading slash belongs to
  // regexes, globs and URLs far more often than to a Windows path.
  let text = value
    .replace(/(?<![A-Za-z0-9])\/([A-Za-z])\//g, (_m, d) => `${d.toUpperCase()}:/`)
    .replace(
      /(?<![A-Za-z0-9])([A-Za-z]):\/([^\s"'<>|]*)/g,
      (_m, d, rest) => `${d}:\\${rest.replace(/\//g, "\\")}`,
    );

  for (const root of trackedRoots()) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(escaped, "gi"), root);
  }
  return text;
}

// Only the copy sent to Gortex is rewritten; OpenCode still runs its own
// original tool input. `command` matters most: a shell command is the one field
// no host normalises, which makes it the field the policy leaks through.
function normalizePayload(payload) {
  try {
    const next = { ...payload };
    if (typeof next.cwd === "string") next.cwd = canonicalPath(next.cwd);

    if (next.tool_input && typeof next.tool_input === "object") {
      const toolInput = { ...next.tool_input };
      for (const field of ["file_path", "path", "notebook_path", "command"]) {
        if (typeof toolInput[field] === "string") {
          toolInput[field] = canonicalPath(toolInput[field]);
        }
      }
      next.tool_input = toolInput;
    }
    return next;
  } catch {
    return payload;
  }
}

async function callGortex(payload) {
  let proc;
  try {
    proc = Bun.spawn(["gortex", "hook", "--agent=claude", "--mode=enrich"], {
      stdin: new TextEncoder().encode(JSON.stringify(normalizePayload(payload))),
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return null;
  }

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, GORTEX_TIMEOUT_MS);

  try {
    const raw = await new Response(proc.stdout).text();
    await proc.exited;
    if (!raw || !raw.trim()) return null;

    const parsed = JSON.parse(raw);
    const context =
      parsed?.hookSpecificOutput?.additionalContext ?? parsed?.additionalContext;
    return typeof context === "string" && context.trim() ? context : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves index readiness for `cwd`, waiting out an index in flight.
 *
 * The shared module owns the hard parts — liveness before readiness, the
 * indexed-versus-resolvable distinction, and the wait loop — so this is only a
 * transport. A verdict that cannot be obtained is treated as "allow", because
 * failing closed here would make a broken plugin indistinguishable from a
 * broken daemon and lock the user out of their own session.
 */
async function readinessVerdict(cwd) {
  let proc;
  try {
    proc = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        GATE_SCRIPT,
        "-Cwd",
        cwd,
        "-Json",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
  } catch {
    return null;
  }

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, GATE_TIMEOUT_MS);

  try {
    const raw = await new Response(proc.stdout).text();
    await proc.exited;
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw.trim());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default async ({ directory, worktree }) => {
  const cwd = worktree || directory || process.cwd();
  // sessionID -> Promise<string|null>, so concurrent requests share one call.
  const orientation = new Map();
  // Sessions whose graph is confirmed ready; re-probing every turn would add
  // latency for a state that does not regress within a session.
  const cleared = new Set();
  // sessionID -> operator-facing reason the graph is unusable.
  const blocked = new Map();

  return {
    "chat.message": async ({ sessionID }) => {
      const key = sessionID ?? "default";
      if (cleared.has(key)) return;

      const verdict = await readinessVerdict(cwd);
      if (!verdict) {
        cleared.add(key);
        return;
      }

      if (verdict.Decision === "block") {
        blocked.set(key, verdict.Reason ?? "The Gortex graph is unavailable.");
        return;
      }

      blocked.delete(key);
      cleared.add(key);
    },

    "experimental.chat.system.transform": async ({ sessionID }, output) => {
      const key = sessionID ?? "default";

      // A blocked session must be told so in the strongest terms available.
      // OpenCode has no hook decision that aborts a turn, so the directive is
      // the enforcement point, and it has to outrank the orientation text.
      const reason = blocked.get(key);
      if (reason) {
        output.system.push(
          [
            "STOP - the Gortex code graph is not usable in this workspace, and this environment requires it.",
            "",
            reason,
            "",
            "Do not fall back to raw file reads, grep, or glob to explore the codebase:",
            "the graph is the only complete view of it, and partial answers here are worse",
            "than none. Report this to the user and stop.",
          ].join("\n"),
        );
        return;
      }

      if (!orientation.has(key)) {
        orientation.set(
          key,
          callGortex({
            hook_event_name: "SessionStart",
            session_id: key,
            cwd,
            source: "startup",
          }),
        );
      }

      const context = await orientation.get(key);
      if (context) output.system.push(context);
    },

    "tool.execute.after": async ({ tool, sessionID, args }, output) => {
      const name = String(tool || "").toLowerCase();
      if (!ENRICHED_TOOLS.has(name)) return;

      const context = await callGortex({
        hook_event_name: "PostToolUse",
        session_id: sessionID ?? "default",
        cwd,
        tool_name: TOOL_NAME_MAP[name] ?? tool,
        tool_input: args ?? {},
        tool_response: String(output.output ?? "").slice(0, 20000),
      });
      if (context) output.output = `${output.output}\n\n${context}`;
    },
  };
};
