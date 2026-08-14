// Exercises the OpenCode plugin's control flow outside OpenCode.
// Bun.spawn is shimmed onto Node's child_process so the plugin calls the REAL
// gate script; only the runtime is substituted, not the logic under test.
import { spawn } from "node:child_process";
import { Readable } from "node:stream";

globalThis.Bun = {
  spawn(cmd, opts = {}) {
    const child = spawn(cmd[0], cmd.slice(1), {
      stdio: ["pipe", "pipe", "ignore"],
      env: process.env,
    });
    if (opts.stdin) {
      child.stdin.write(Buffer.from(opts.stdin));
      child.stdin.end();
    } else {
      child.stdin.end();
    }
    return {
      stdout: Readable.toWeb(child.stdout),
      exited: new Promise((r) => child.on("close", r)),
      kill: () => child.kill(),
    };
  },
};

const REPO = process.argv[3] ?? process.cwd();
const plugin = (await import(process.argv[2])).default;

function makeOutput() {
  return { system: [], output: "" };
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

// --- Case 1: ready repo -> no STOP directive, session cleared ---------------
{
  const h = await plugin({ directory: REPO, worktree: REPO });
  await h["chat.message"]({ sessionID: "s1" }, {});
  const out = makeOutput();
  await h["experimental.chat.system.transform"]({ sessionID: "s1" }, out);
  const stop = out.system.some((s) => s.startsWith("STOP"));
  check("ready repo injects no STOP directive", !stop);
}

// --- Case 2: daemon unreachable -> STOP directive injected ------------------
{
  const fake = `${process.env.TEMP}\\gortex-oc-${Date.now()}`;
  await import("node:fs").then((fs) => fs.mkdirSync(fake, { recursive: true }));
  process.env.GORTEX_HOME = fake;

  const h = await plugin({ directory: REPO, worktree: REPO });
  await h["chat.message"]({ sessionID: "s2" }, {});
  const out = makeOutput();
  await h["experimental.chat.system.transform"]({ sessionID: "s2" }, out);

  const stop = out.system.find((s) => s.startsWith("STOP"));
  check("blocked repo injects STOP directive", Boolean(stop));
  check(
    "STOP directive carries the gate's reason",
    Boolean(stop && stop.includes("daemon")),
    stop ? "" : "(no directive)",
  );
  check(
    "STOP directive forbids grep/glob fallback",
    Boolean(stop && stop.includes("Do not fall back")),
  );
  check(
    "orientation text is suppressed while blocked",
    out.system.length === 1,
    `(system entries=${out.system.length})`,
  );

  delete process.env.GORTEX_HOME;
  await import("node:fs").then((fs) =>
    fs.rmSync(fake, { recursive: true, force: true }),
  );
}

// --- Case 3: cleared session does not re-probe the gate ---------------------
{
  const h = await plugin({ directory: REPO, worktree: REPO });
  const t0 = Date.now();
  await h["chat.message"]({ sessionID: "s3" }, {});
  const first = Date.now() - t0;
  const t1 = Date.now();
  await h["chat.message"]({ sessionID: "s3" }, {});
  const second = Date.now() - t1;
  check(
    "second turn skips the gate probe",
    second < 50 && first > second,
    `(first=${first}ms second=${second}ms)`,
  );
}

// --- Case 4: tool enrichment appends without destroying tool output --------
{
  const h = await plugin({ directory: REPO, worktree: REPO });
  const out = { system: [], output: "original tool output" };
  await h["tool.execute.after"](
    { tool: "grep", sessionID: "s4", args: { pattern: "class" } },
    out,
  );
  check(
    "enrichment preserves the original tool output",
    out.output.startsWith("original tool output"),
    `(got: ${String(out.output).slice(0, 40)})`,
  );

  const skipped = { system: [], output: "untouched" };
  await h["tool.execute.after"](
    { tool: "todowrite", sessionID: "s4", args: {} },
    skipped,
  );
  check(
    "non-search tools are not enriched",
    skipped.output === "untouched",
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
