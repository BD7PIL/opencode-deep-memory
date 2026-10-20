# Security policy

## Scope

`@bd7pil/opencode-deep-memory` is an opencode plugin. It runs **inside the
engine process** with the engine's privileges and:

- reads conversation/session data the engine hands it,
- writes memory files under the project (`.deep-memory/`) and the global data
  directory (`~/.local/share/opencode/deep-memory/` by default),
- registers tools and a compaction hook,
- makes no network requests of its own.

The most important security property is therefore **data handling, not
transport**: the memory files contain conversation excerpts, which may include
whatever the user pasted into a session. They are plain files under the
project and the user's data directory.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability
reporting (`Security` → `Report a vulnerability`) or contact `@BD7PIL`.
Include the package version, the engine version, the smallest reproduction,
and what an attacker gains (data read/write, tool invocation, path escape).

Confirmed issues are fixed in a patch release and credited unless you ask
otherwise.

## Operator guidance

- Do not commit `.deep-memory/` to a repository. It is ignored by default in
  this project, but other projects must ignore it too.
- The global memory root is shared across projects; treat it as sensitive as
  the sessions it summarizes.
- The plugin never stores provider credentials. Those remain in the engine's
  `auth.json` and are never copied into memory files.
- Run the plugin with the same trust level as the engine itself: it executes
  in-process, so a malicious plugin or model output can influence what it
  writes.

## Contributor rules

- No network calls from `src/`.
- No credential-shaped strings in fixtures or memory files (use synthetic
  values such as `DEVICE-42`, never a real key).
- Paths derived from model or user input must be validated against the
  configured memory root before use. `src/shared/paths.ts` is the single
  resolver — add validation there rather than creating a second path resolver.
- Tests must not read or write a user's real memory directory.
