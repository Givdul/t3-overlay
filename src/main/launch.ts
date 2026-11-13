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

export async function launchT3() {
  const exe = findT3Executable();
  if (exe === null) {
    void dialog.showMessageBox({ type: "error", message: "Could not find T3 Code under %LOCALAPPDATA%\\Programs\\t3code." });
    return;
  }
  spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
}
