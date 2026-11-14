// macOS command sandbox: wraps run_command in a Seatbelt (sandbox-exec)
// profile. Network is denied; file writes are allowed only inside the
// working folder, the service folder and the system temp directories.
// Reads and process execution stay allowed.

import fs from "node:fs/promises";
import path from "node:path";

export const SEATBELT_BIN = "/usr/bin/sandbox-exec";

export const SEATBELT_PROFILE = `(version 1)
(deny network*)
(deny file-write*)
(allow file-write*
  (subpath (param "CWD"))
  (subpath (param "DATA"))
  (regex #"^/private/var/folders/")
  (literal "/dev/null")
  (literal "/dev/zero"))`;

/** Writes the profile (once per run) and returns its path. */
export async function ensureSeatbeltProfile(dataDir) {
  const profilePath = path.join(dataDir, "sandbox.sb");
  await fs.writeFile(profilePath, SEATBELT_PROFILE, "utf8");
  return profilePath;
}

/**
 * The spawn wrapper for runCommand(): sandbox-exec execs /bin/sh inside the
 * profile, with the paths passed as profile parameters. The working folder
 * itself does not need any extra ACLs on macOS.
 */
export function seatbeltWrap({ profilePath, cwd, dataDir, tmpDir }) {
  return {
    program: SEATBELT_BIN,
    args: [
      "-f", profilePath,
      "-D", `CWD=${cwd}`,
      "-D", `DATA=${dataDir}`,
      "-D", `TMP=${tmpDir}`,
      "/bin/sh",
    ],
    shellName: "sh (sandbox)",
  };
}

/** Returns true when the marker looks like a sandbox infrastructure error. */
export function isSandboxInfraError(stderr) {
  return /sandbox_setup|sandbox-exec:|error compiling|parse error|cannot parse/i
    .test(stderr || "");
}
