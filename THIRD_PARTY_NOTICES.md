# Third-party notices (dsh-studio)

dsh-studio itself is Apache-2.0 (see LICENSE and NOTICE).

## Bundled npm packages

None. This notice was regenerated from the source maps of the built `lib/` output after the tldraw canvas was removed:
`lib/index.js`, `lib/client.js` and `lib/client.workbench.js` contain no code from `node_modules`. The browser bundles only
`require()` modules that the DSH shell provides (`react`, `react-dom`, `react/jsx-runtime`); the host bundle only imports
Node.js built-ins and `@deepseek-ai/*` packages that DSH provides.

Optional runtime dependency, not bundled and not distributed with this package: `sharp` (Apache-2.0) is loaded with a dynamic
`import()` when it is installed, for image thumbnails and masks.

## Adapted source code

Source code adapted from other projects is credited in NOTICE:

- `src/subscription/`: adapted from `@goodandready/dsh-subscriptions` (MIT, Copyright (c) 2026 GooDAnDReaDY), via dsh-image-gen.
- `src/kit/`: adapted, via dsh-kit, from `@deepseek-ai/dsh-client-ui-primitives` (MIT, Copyright (c) 2026 DeepSeek).
- The base of this project is dsh-image-gen (Apache-2.0, Copyright 2026 shanliuling and contributors).

## MIT licence text (applies to the two MIT-licensed adaptations above)

```
MIT License

Copyright (c) 2026 GooDAnDReaDY
Copyright (c) 2026 DeepSeek

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
