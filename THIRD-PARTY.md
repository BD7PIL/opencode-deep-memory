# Third-party notices

The published package **bundles** the following dependency into `dist/` (its
source is compiled in, so it is redistributed, not merely depended on). The
license text below is the one shipped by the upstream package.

## zod 4.1.8

- Upstream: https://github.com/colinhacks/zod
- License: MIT
- Copyright (c) 2025 Colin McDonnell
- Why bundled: the plugin's tool schemas are defined with zod. opencode v2
  loads plugins from a directory on hosts that may be air-gapped, so the
  package must be self-contained — a runtime `import "zod"` would fail there.

```text
MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Build-time dependencies (tsup, TypeScript, Vitest, `@opencode-ai/plugin`,
`@opencode-ai/sdk`) are not redistributed in the npm tarball and remain under
their own licenses.
