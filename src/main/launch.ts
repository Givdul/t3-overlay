import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { dialog } from "electron";
import { isAlive } from "./t3";

function findT3Executable(): string | null {
  if (process.platform !== "win32") return null;
  const dir = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "t3code");
  if (!existsSync(dir)) return null;
  const exe = readdirSync(dir).find((name) => /^T3 Code.*\.exe$/i.test(name));
  return exe ? join(dir, exe) : null;
}

export async function launchT3WithDebugPort(port: number) {
  const exe = findT3Executable();
  if (exe === null) {
    void dialog.showMessageBox({ type: "error", message: "Could not find T3 Code under %LOCALAPPDATA%\\Programs\\t3code." });
    return;
  }
  spawn(exe, [`--remote-debugging-port=${port}`], { detached: true, stdio: "ignore" }).unref();
}

function parentPid(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`],
      { windowsHide: true },
      (error, stdout) => resolve(error ? null : Number.parseInt(stdout.trim(), 10) || null),
    );
  });
}

/** Asks T3 to quit, waits for it to exit, then starts it again with the debugging port. */
export async function restartT3WithDebugPort(port: number) {
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Restart T3", "Cancel"],
    defaultId: 1,
    message: "Restart T3 Code with the debug port?",
    detail: "Running turns are interrupted. T3 opens again with a local debugging port, so the overlay can list threads from every machine and follow T3's theme.",
  });
  if (response !== 0) return;

  const runtime = JSON.parse(await readFile(join(homedir(), ".t3", "userdata", "server-runtime.json"), "utf8"));

  if (!isAlive(runtime.pid)) return;
  const main = await parentPid(runtime.pid);
  if (main === null) return;
  // taskkill without /F sends WM_CLOSE, so T3 shuts down its server cleanly.
  execFile("taskkill", ["/PID", String(main)], { windowsHide: true });
  for (let i = 0; i < 60 && isAlive(main); i++) await new Promise((resolve) => setTimeout(resolve, 500));
  if (isAlive(main)) {
    void dialog.showMessageBox({ type: "warning", message: "T3 Code did not quit. Quit it yourself, then use Launch T3 with the debug port." });
    return;
  }
  await launchT3WithDebugPort(port);
}
