import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dialog } from "electron";

function findT3Executable(): string | null {
  if (process.platform !== "win32") return null;
  const dir = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "t3code");
  if (!existsSync(dir)) return null;
  const exe = readdirSync(dir).find((name) => /^T3 Code.*\.exe$/i.test(name));
  return exe ? join(dir, exe) : null;
}

/** Opens a project's new-thread draft in the running T3 Code app, through its own CLI. */
export function openProjectInT3(workspaceRoot: string) {
  const cli = join(homedir(), ".t3", "bin", process.platform === "win32" ? "t3.cmd" : "t3");

  // .cmd shims run through cmd.exe. The path is T3's own project root, quoted as one argument.
  const [file, args] =
    process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", `"${cli}" app "${workspaceRoot}"`]] : [cli, ["app", workspaceRoot]];

  const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });

  child.on("error", (error) => console.error("[t3] could not open the project in T3", error));
  child.unref();
}

export async function launchT3() {
  const exe = findT3Executable();
  if (exe === null) {
    void dialog.showMessageBox({ type: "error", message: "Could not find T3 Code under %LOCALAPPDATA%\\Programs\\t3code." });
    return;
  }
  spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
}
