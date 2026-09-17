/** Version is a minimum baseline, not an allowlist of individual releases.
 * Native catalogs, identities, previews and receipts still require their own validation.
 * Prerelease builds are deliberately not admitted to repository administration.
 */
export function nativeCompatibility(version: string, administration = true): { available: boolean; reason: string } {
  const match = /^(?:gortex\s+)?v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  const parts = match?.slice(1, 4).map(Number);
  const minimum = administration ? 3 : 2;
  const available = !!parts && parts.every(Number.isSafeInteger) && (parts[0] > 0 || parts[1] > 64 || (parts[1] === 64 && parts[2] >= minimum));
  return { available, reason: available
    ? "Native responses and repository identity are validated before administration. Changes require confirmation."
    : `This operation requires a stable Gortex release >= 0.64.${minimum}. Detected: ${version}. Prerelease or unrecognized versions require compatibility verification.` };
}

export function requireTrackCliSupport(help: string): void {
  if (!/\bgortex\s+track\s+<path>/.test(help) || !/--no-progress(?=\s|$)/.test(help)) {
    throw new Error("This Gortex executable does not advertise the required track <path> --no-progress interface. No tracking request was sent; update the plugin for this native interface.");
  }
}

export function requireNativeCompatibility(version: string, administration = true): void {
  const result = nativeCompatibility(version, administration);
  if (!result.available) throw new Error(result.reason);
}
