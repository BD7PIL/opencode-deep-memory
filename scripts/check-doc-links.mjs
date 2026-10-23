#!/usr/bin/env node
// Documentation link gate: relative links must resolve inside the public tree,
// and same-repo GitHub blob/tree links must point at a path that exists.
//
//   node scripts/check-doc-links.mjs
//
// External http(s) links are not fetched — CI stability first. Historical
// documents are checked too; a broken path there is still a 404 for a reader.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const skipDirs = new Set(['node_modules', '.git', 'dist', 'coverage', '.zcode'])

let repo = ''
try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  repo = /github\.com[/:]([^/]+\/[^/.#]+)/.exec(pkg.repository?.url ?? '')?.[1] ?? ''
} catch {
  // A missing/invalid package.json is not a docs problem; the link check can
  // still enforce relative paths.
}

function markdownFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) out.push(...markdownFiles(path))
    else if (name.endsWith('.md')) out.push(path)
  }
  return out
}

function linksOf(text) {
  const out = []
  const re = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  for (;;) {
    const m = re.exec(text)
    if (!m) break
    if (m[1] === '!') continue
    const target = m[2].trim()
    if (!target || target.startsWith('#') || target.startsWith('mailto:')) continue
    out.push(target)
  }
  return out
}

const failures = []
for (const file of markdownFiles(root)) {
  const rel = file.slice(root.length + 1).replaceAll('\\', '/')
  for (const target of linksOf(readFileSync(file, 'utf8'))) {
    if (/^[a-z]+:/i.test(target)) {
      if (
        repo &&
        target.includes(`github.com/${repo}/`) &&
        /github\.com\/[^/]+\/[^/]+\/(blob|tree)\//i.test(target)
      ) {
        const path = target
          .replace(/^.*github\.com\/[^/]+\/[^/]+\/(?:blob|tree)\/[^/]+\//i, '')
          .split('#')[0]
        if (!existsSync(join(root, decodeURIComponent(path)))) {
          failures.push(`${rel}: stale same-repo link ${target}`)
        }
      }
      continue
    }
    const local = decodeURIComponent(target.split('#')[0])
    const abs = isAbsolute(local) ? local : resolve(dirname(file), local)
    if (!existsSync(abs)) failures.push(`${rel}: missing relative target ${target}`)
  }
}

if (failures.length) {
  console.error('documentation links failed:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('documentation links: OK')
