import fs from "node:fs";
import nodePath from "node:path";
import { scopeDir } from "./paths.js";
import type { Logger } from "./log.js";

const MIGRATED_MARKER = ".migrated-v4";

export async function migrateV3toV4(projectPath: string, logger?: Logger): Promise<void> {
  const dir = scopeDir("project", projectPath);
  const marker = nodePath.join(dir, MIGRATED_MARKER);
  if (fs.existsSync(marker)) return;

  fs.mkdirSync(dir, { recursive: true });
  const deleted: string[] = [];
  const archived: string[] = [];

  const filesToDelete = [
    "checkpoint.raw.json",
    "notes.md",
    ".schedule.json",
  ];

  for (const fname of filesToDelete) {
    const fpath = nodePath.join(dir, fname);
    try {
      fs.unlinkSync(fpath);
      deleted.push(fname);
    } catch { /* not present */ }
  }

  const archiveDir = nodePath.join(dir, "archive");
  const distillFiles = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.startsWith("distill-") && f.endsWith(".md"))
    : [];
  if (distillFiles.length > 0) {
    fs.mkdirSync(archiveDir, { recursive: true });
    for (const fname of distillFiles) {
      const src = nodePath.join(dir, fname);
      const dst = nodePath.join(archiveDir, fname);
      fs.renameSync(src, dst);
      archived.push(fname);
    }
  }

  const memoryPath = nodePath.join(dir, "MEMORY.md");
  if (fs.existsSync(memoryPath)) {
    const content = fs.readFileSync(memoryPath, "utf8");
    const lines = content.split("\n");
    if (lines.length > 200) {
      const archivePath = nodePath.join(dir, "MEMORY-archive.md");
      const overflow = lines.slice(200).join("\n");
      fs.writeFileSync(memoryPath, lines.slice(0, 200).join("\n"), "utf8");
      fs.appendFileSync(archivePath, `\n${overflow}\n`, "utf8");
      archived.push("MEMORY.md (trimmed to 200 lines, overflow to MEMORY-archive.md)");
    }
  }

  fs.writeFileSync(marker, new Date().toISOString(), "utf8");

  if (deleted.length > 0 || archived.length > 0) {
    logger?.info("V3→V4 migration complete", { deleted, archived });
  }
}
