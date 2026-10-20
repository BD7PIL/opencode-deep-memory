#!/usr/bin/env node
// Gate for the public tree: no private addresses, no developer home paths, no
// credential-shaped strings. Runs both in CI (on the source tree, minus
// docs/.zcode) and inside publish-repo.sh (on the exported tree, where nothing
// is excluded because the excluded paths are already gone).
//
//   node scripts/check-public-tree.mjs --root . --exclude docs --exclude .zcode
//
// Exit 1 on the first violation, printing every hit it found.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const args = process.argv.slice(2);
let root = ".";
const excludes = new Set([".git", "node_modules"]);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--root") root = args[++i];
  else if (args[i] === "--exclude") excludes.add(args[++i].replace(/[\\/]+$/, ""));
  else throw new Error(`unknown argument: ${args[i]}`);
}

// Generic placeholders that may legitimately appear in docs and tests.
// Anything else under /home must be rewritten to ~ or $HOME before publishing.
const HOME_ALLOW = new Set(["x", "user", "runner", "node", "app", "example", "test", "demo-user"]);

const RULES = [
  { id: "private-ipv4", re: /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/g },
  { id: "developer-home", re: /\/home\/([A-Za-z0-9._-]+)\//g, keep: (m) => !HOME_ALLOW.has(m[1].toLowerCase()) },
  { id: "windows-home", re: /[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9._-]+/gi },
  { id: "developer-tree", re: /\b[A-Za-z]:[\\/]+(?:develop|projects|work)[\\/]/gi },
  { id: "reference-area", re: /\bomo-slim-ref\b/g },
  { id: "credential", re: /\b(?:sk-[A-Za-z0-9_-]{20,}|tvly-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g },
  { id: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

const hits = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const rel = relative(root, path).split(sep).join("/");
    if (excludes.has(rel) || excludes.has(entry)) continue;
    const st = statSync(path);
    if (st.isDirectory()) {
      walk(path);
      continue;
    }
    if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
    const buffer = readFileSync(path);
    if (buffer.includes(0)) continue; // binary
    const text = buffer.toString("utf8");
    text.split(/\r?\n/).forEach((line, index) => {
      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        let match = rule.re.exec(line);
        while (match !== null) {
          if (!rule.keep || rule.keep(match)) {
            hits.push(`${rel}:${index + 1}: ${rule.id}: ${line.trim().slice(0, 160)}`);
          }
          match = rule.re.exec(line);
        }
      }
    });
  }
}

walk(root);

if (hits.length > 0) {
  console.error(`public-tree gate failed: ${hits.length} hit(s) under ${root}`);
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log(`public-tree gate: clean (${root})`);
