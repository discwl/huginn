import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, parse } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { resolveHostExecutable } from "./host-executable.ts";
import { runProcess } from "./process-runner.ts";

const windows = process.platform === "win32";
const execute = promisify(execFile);
const nativeName = (name: string) => windows ? `${name}.exe` : name;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "gortex-host-executable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = join(root, "host tools");
  const repo = join(root, "candidate repository");
  await Promise.all([mkdir(host), mkdir(repo)]);
  return { root, host, repo };
}

async function executable(path: string) {
  await writeFile(path, "host executable fixture\n");
  if (!windows) await chmod(path, 0o755);
  return path;
}

test("explicit absolute host binary is preserved independently of PATH", async () => {
  assert.equal(await resolveHostExecutable(process.execPath, { PATH: "." }), process.execPath);
  assert.equal((await runProcess(process.execPath, ["-p", "'absolute host'"], tmpdir())).trim(), "absolute host");
});

test("PATH lookup keeps absolute directory order and skips non-files", async t => {
  const { root, host } = await fixture(t);
  const first = join(root, "first");
  await mkdir(join(first, nativeName("host-probe")), { recursive: true });
  const expected = await executable(join(host, nativeName("host-probe")));
  const path = ["", ".", "relative-bin", first, host].join(delimiter);
  assert.equal(await resolveHostExecutable("host-probe", { PATH: path }), expected);
  await executable(join(first, nativeName("another-probe")));
  await executable(join(host, nativeName("another-probe")));
  assert.equal(await resolveHostExecutable("another-probe", { PATH: [first, host].join(delimiter) }), join(first, nativeName("another-probe")));
});

test("relative commands and missing trusted binaries fail visibly", async () => {
  for (const command of ["./git", "../git", "gortex-does-not-exist"]) {
    await assert.rejects(resolveHostExecutable(command, { PATH: ["", ".", "relative-bin"].join(delimiter) }), { code: "process_unavailable" });
  }
  await assert.rejects(runProcess("gortex-does-not-exist-for-host-test", [], tmpdir()), { code: "process_unavailable" });
});

test("Windows accepts quoted absolute PATH, case-insensitive PATH keys, COM and EXE", { skip: !windows }, async t => {
  const { root, host } = await fixture(t);
  const other = join(root, "other");
  await mkdir(other);
  const expected = await executable(join(host, "native-probe.exe"));
  await executable(join(other, "native-probe.exe"));
  const drive = parse(host).root.slice(0, 2);
  const path = ["", ".", "relative-bin", `${drive}relative-bin`, "\\relative-bin", `"${host}"`].join(";");
  assert.equal(await resolveHostExecutable("native-probe", { Path: path }), expected);
  assert.equal(await resolveHostExecutable("native-probe.EXE", { Path: path }), join(host, "native-probe.EXE"));
  assert.equal(await resolveHostExecutable("native-probe", { PATH: host, Path: other }), expected);
  const com = await executable(join(host, "native-probe.com"));
  assert.equal(await resolveHostExecutable("native-probe", { Path: host }), com);
  assert.equal(await resolveHostExecutable(join(host, "native-probe"), {}), com);
  for (const command of [`${drive}native-probe.exe`, "\\native-probe.exe", "relative-bin\\native-probe.exe"]) {
    await assert.rejects(resolveHostExecutable(command, { Path: host }), { code: "process_unavailable" });
  }
});

test("Windows does not admit PATHEXT script or shell relays", { skip: !windows }, async t => {
  const { host } = await fixture(t);
  const script = await executable(join(host, "native-probe.cmd"));
  for (const command of ["native-probe", "native-probe.cmd", script]) {
    await assert.rejects(resolveHostExecutable(command, { Path: host, PATHEXT: ".CMD;.BAT;.EXE" }), { code: "process_unavailable" });
  }
});

test("POSIX skips non-executable files and uses the default host PATH only when PATH is absent", { skip: windows }, async t => {
  const { root, host } = await fixture(t);
  const first = join(root, "first");
  await mkdir(first);
  await writeFile(join(first, "native-probe"), "not executable\n", { mode: 0o644 });
  const expected = await executable(join(host, "native-probe"));
  assert.equal(await resolveHostExecutable("native-probe", { PATH: `${first}:${host}` }), expected);
  assert.match(await resolveHostExecutable("sh", {}), /^\/(?:usr\/)?bin\/sh$/);
  await assert.rejects(resolveHostExecutable("sh", { PATH: "" }), { code: "process_unavailable" });
  await assert.rejects(resolveHostExecutable("native-probe", { PATH: `"${host}"` }), { code: "process_unavailable" });
});

test("repository-local executables cannot hijack process probes or MCP startup", async t => {
  const { root, host, repo } = await fixture(t);
  for (const directory of [host, repo]) {
    for (const name of ["git", "gortex"]) await copyFile(process.execPath, join(directory, nativeName(name)));
  }
  const preload = join(root, "record-native-launch.cjs");
  const marker = join(root, "native-launch.txt");
  await writeFile(preload, 'require("node:fs").appendFileSync(process.env.HOST_EXECUTABLE_MARKER, process.execPath + "\\n"); process.exit(1);\n');
  const source = `
    import assert from "node:assert/strict";
    import { spawnSync } from "node:child_process";
    import { readFile } from "node:fs/promises";
    import { join } from "node:path";
    import { runProcess } from ${JSON.stringify(new URL("./process-runner.ts", import.meta.url).href)};
    import { GortexClient } from ${JSON.stringify(new URL("./gortex-client.ts", import.meta.url).href)};
    const [host, repo, preload, marker] = process.argv.slice(1);
    const windows = process.platform === "win32";
    const nativeName = name => windows ? name + ".exe" : name;
    assert.equal(Object.keys(process.env).some(key => key.toLowerCase() === "nodefaultcurrentdirectoryinexepath"), false);
    if (windows) {
      // Reproduce libuv's unsafe lookup in a parent without the ambient opt-out flag.
      // Even setting the flag only in the probe's child env does not secure resolution.
      const unsafe = spawnSync("git", ["-p", "process.execPath"], {
        cwd: repo, encoding: "utf8", shell: false, windowsHide: true,
        env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" }
      });
      assert.equal(unsafe.status, 0, unsafe.stderr);
      assert.equal(unsafe.stdout.trim().toLowerCase(), join(repo, "git.exe").toLowerCase());
    }
    const output = await runProcess("git", ["-p", "process.execPath"], repo);
    assert.equal(output.trim().toLowerCase(), join(host, nativeName("git")).toLowerCase());
    process.env.NODE_OPTIONS = "--require " + JSON.stringify(preload);
    process.env.HOST_EXECUTABLE_MARKER = marker;
    const native = new GortexClient();
    try {
      await assert.rejects(native.query(repo, "search", { query: "host probe" }), { code: "mcp_unavailable" });
    } finally { await native.close(); }
    const launches = await readFile(marker, "utf8");
    assert.equal(launches.trim().toLowerCase(), join(host, nativeName("gortex")).toLowerCase());
    process.env.PATH = windows ? ";.;relative-bin" : ":.:relative-bin";
    await assert.rejects(runProcess("git", [], repo), { code: "process_unavailable" });
    const unavailable = new GortexClient();
    try {
      await assert.rejects(unavailable.query(repo, "search", { query: "missing host" }), { code: "process_unavailable" });
    } finally { await unavailable.close(); }
    assert.equal(await readFile(marker, "utf8"), launches);
    process.stdout.write("trusted host probes and MCP startup verified");
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["path", "node_options", "nodefaultcurrentdirectoryinexepath"].includes(key.toLowerCase())));
  env.PATH = ["", ".", "relative-bin", host].join(delimiter);
  const result = await execute(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", source, host, repo, preload, marker], {
    cwd: repo, env, windowsHide: true, timeout: 20000, maxBuffer: 65536
  });
  assert.equal(result.stdout, "trusted host probes and MCP startup verified");
});
