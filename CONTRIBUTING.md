# Contributing to opencode-deep-memory

`@bd7pil/opencode-deep-memory` gives an opencode engine persistent memory:
capture-time limits, stale-read rewriting, a byte-stable `MEMORY.md` for the
system prompt, hybrid retrieval, consolidation and agent-initiated compression.
It supports both opencode v1 and v2.

## Setup

Node.js >= 20.

```bash
npm install
npm run build
npm test
```

## Checks before a PR

```bash
npm run lint              # Biome, lint-only (formatting is not enforced)
npm run typecheck
npm run build             # tests load the built dist on purpose
npm test
npm run smoke
npm run e2e:real-bugs     # regressions that once shipped through green unit tests
npm run e2e:v2            # real opencode v2 engine against a stub LLM (38 checks)
```

On a real release also run `npm run verify:release`, which adds the v2 gate to
the full sequence. CI runs all of the above plus the coverage gate below.

## Coverage

`npm run test:coverage` enforces the hard floor in `vitest.config.ts`
(`coverage.thresholds`). It only ratchets up: raise a threshold together with
the tests that raised it — never lower one to make a red run green. The floor
is anchored to node 24 — the unified main line across the three repos (dev
machine, CI gate leg and the engine runtime all run 24); CI's node-20 leg is an
engines-floor compatibility check and does not run coverage. A weekly CI cron
also runs `BENCH=1 npm test` for the timing benchmark suite, which is skipped
on PRs on purpose (loose timing assertions flake on loaded machines).

## Tests and fixtures

- Unit/integration tests live in `tests/**/*.test.ts` (Vitest).
- **Fixtures must be synthetic.** No real API keys, hostnames, user home
  paths, repository names, or conversation content. Use values such as
  `DEVICE-42`, `CARD-7`, `ExampleSuite`.
- A test must never read or write the developer's real memory directory; use
  `mkdtemp` and the env overrides documented in `src/shared/paths.ts`.
- The `e2e:v2` gate boots a real engine with a stub LLM; it must stay offline
  and must not contact a provider.

## Packaging rules

- The published tarball is built by `tsup`; `dist/` is produced, not committed.
- Anything bundled into `dist/` must be listed in `THIRD-PARTY.md` with its
  license text. zod is bundled today; the publish workflow asserts the file
  ships.
- `index.js` at the root is the directory-install entry (`export { default }
  from "./dist/index.js"`). Do not remove it: opencode v2 resolves a directory
  to `<dir>/index.js` and ignores `package.json`.
- Keep the package self-contained: no runtime `peerDependencies` that a host
  without network access cannot resolve.

## Style and boundaries

- TypeScript strict; match the surrounding code.
- Comments explain **why** a rule exists (often a measured production failure),
  not what the next line does.
- v1 and v2 code paths must both keep working. A change to the adapter needs
  evidence from the real-engine gate, not only a mocked host.
- No network calls from `src/`.
- Do not weaken the memory-root path resolver or write outside the configured
  roots.

## Pull requests

- One logical change per commit; describe the failure it fixes.
- CI must be green (lint, typecheck, tests, smoke, real-bug e2e, v2 engine).
- By contributing you agree your changes are licensed under the MIT License.
