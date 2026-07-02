import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "./log.js";

function pluginDir(): string {
  return nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");
}

export function installPluginCommands(projectPath: string, logger?: Logger): void {
  const srcCmdDir = nodePath.join(pluginDir(), ".opencode", "command");
  const dstCmdDir = nodePath.join(projectPath, ".opencode", "command");
  if (!fs.existsSync(srcCmdDir)) {
    logger?.debug("installCommands: no .opencode/command/ in plugin", { srcCmdDir });
    return;
  }
  fs.mkdirSync(dstCmdDir, { recursive: true });
  for (const file of fs.readdirSync(srcCmdDir)) {
    const src = nodePath.join(srcCmdDir, file);
    const dst = nodePath.join(dstCmdDir, file);
    if (fs.statSync(src).isFile()) {
      fs.cpSync(src, dst, { force: true });
      logger?.info("installCommands: installed command", { file, projectPath });
    }
  }
}
