import test from "node:test";
import assert from "node:assert/strict";
import { findWindowsPickerRuntime } from "./windows-picker-runtime.ts";
import { WINDOWS_PICKER_PROBE } from "./windows-dialog.ts";

const home = "C:\\Users\\Nick";
const msi = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
function missing(): never { throw Object.assign(new Error("Cannot start executable"), { code: "process_unavailable" }); }

test("a standard MSI install is found when Paseo inherited a PATH without PowerShell", async () => {
  const calls: string[] = [];
  const result = await findWindowsPickerRuntime({
    home, environment: { ProgramW6432: "C:\\Program Files", ProgramFiles: "C:\\Program Files" },
    run: async (executable, args, cwd, options) => {
      calls.push(executable);
      assert.equal(cwd, home);
      assert.equal(Buffer.from(args.at(-1)!, "base64").toString("utf16le"), WINDOWS_PICKER_PROBE);
      assert.ok(options && options.timeoutMs! <= 4000 && options.maxBytes === 8192);
      return executable === msi ? JSON.stringify({ status: "ready" }) : missing();
    },
  });
  assert.equal(result.available, true);
  assert.equal(result.executable, msi);
  assert.deepEqual(calls, ["pwsh.exe", msi]);
});

test("per-user WindowsApps and dotnet installations are discovered without a fresh PATH", async () => {
  for (const executable of ["C:\\Users\\Nick\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe", "C:\\Users\\Nick\\.dotnet\\tools\\pwsh.exe"]) {
    const result = await findWindowsPickerRuntime({
      home, environment: { LOCALAPPDATA: "C:\\Users\\Nick\\AppData\\Local" },
      run: async candidate => candidate === executable ? JSON.stringify({ status: "ready" }) : missing(),
    });
    assert.equal(result.available, true);
    assert.equal(result.executable, executable);
  }
});

test("an incompatible runtime on PATH does not mask a working standard installation", async () => {
  for (const status of ["powershell_version", "windows_forms"]) {
    const result = await findWindowsPickerRuntime({
      home, environment: { ProgramFiles: "C:\\Program Files" },
      run: async executable => JSON.stringify({ status: executable === msi ? "ready" : status }),
    });
    assert.equal(result.available, true);
    assert.equal(result.executable, msi);
  }
});

test("missing PowerShell, unavailable Forms and a noninteractive session get distinct guidance", async () => {
  for (const [status, expected] of [["missing", /needs PowerShell 7 on this host\. Install it with: winget/], ["powershell_version", /older PowerShell/], ["windows_forms", /can't open the Windows folder dialog/], ["desktop", /signed-in Windows desktop session/]] as const) {
    const result = await findWindowsPickerRuntime({
      home, environment: {},
      run: async executable => executable !== "pwsh.exe" || status === "missing" ? missing() : JSON.stringify({ status }),
    });
    assert.equal(result.available, false);
    assert.equal(result.executable, null);
    assert.match(result.reason, expected);
  }
});

test("a desktop failure does not spawn more shells or suggest that installation grants desktop access", async () => {
  let calls = 0;
  const result = await findWindowsPickerRuntime({
    home, environment: { ProgramFiles: "C:\\Program Files" },
    run: async () => { calls++; return JSON.stringify({ status: "desktop" }); },
  });
  assert.equal(calls, 1);
  assert.equal(result.available, false);
  assert.match(result.reason, /Remote Desktop/);
});

test("malformed and unexpected probe output is never reported as a usable runtime", async () => {
  for (const output of ["not json", '{"available":true}', '{"status":"unknown"}']) {
    const result = await findWindowsPickerRuntime({ home, environment: {}, run: async () => output });
    assert.equal(result.available, false);
    assert.equal(result.executable, null);
    assert.match(result.reason, /folder-picker check failed/);
  }
});
