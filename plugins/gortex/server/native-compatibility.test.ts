import test from "node:test";
import assert from "node:assert/strict";
import { nativeCompatibility, requireNativeCompatibility, requireTrackCliSupport } from "../shared/native-compatibility.ts";
import { WorkspaceLibrary } from "./workspace-library.ts";

for (const version of ["gortex v0.64.3+56a1c29", "gortex v0.64.4", "gortex v0.64.99", "gortex v0.65.0", "gortex v1.0.0", "gortex v2.1.0+build.42"]) {
  test(`catalog enables administration for ${version}`, async () => {
    const library = new WorkspaceLibrary({
      version: async () => version, assignments: async () => [], close: async () => {},
      info: async () => { throw new Error("No repository context requested"); },
      query: async () => { throw new Error("No graph query requested"); },
    });
    try {
      const catalog = await library.catalog();
      assert.equal(catalog.administration.available, true);
      assert.equal(catalog.version, version);
      assert.doesNotThrow(() => requireNativeCompatibility(version));
    } finally { library.close(); }
  });
}

test("old, prerelease and malformed versions cannot enable repository writes", () => {
  for (const version of ["gortex v0.64.2", "v0.63.99", "v0.64.4-rc.1", "v1.0.0-beta", "v0.64.4junk", "v0.64.4+", "v00.64.4", "unknown", "v999999999999999999.0.0"]) {
    assert.equal(nativeCompatibility(version).available, false, version);
    assert.throws(() => requireNativeCompatibility(version), /stable Gortex release/);
  }
  assert.equal(nativeCompatibility("gortex v0.64.2", false).available, true);
});

test("CLI tracking requires its actual interface, independently of version", () => {
  assert.doesNotThrow(() => requireTrackCliSupport("Usage:\n  gortex track <path> [flags]\nGlobal Flags:\n --no-progress disable progress"));
  for (const help of ["", "gortex track <path>", "gortex track --no-progress", "gortex track <path> --no-progress-extra"]) {
    assert.throws(() => requireTrackCliSupport(help), /No tracking request was sent/);
  }
});
