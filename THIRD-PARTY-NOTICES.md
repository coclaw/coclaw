# Third-Party Notices

CoClaw incorporates third-party components — both open-source components and, in the Android layer, separately licensed proprietary SDK components. This document is a consolidated inventory of the third-party components that the CoClaw software depends on or integrates — both components that are bundled into a shipped artifact and components that are declared as dependencies and installed from npm by whoever runs the software. For each it records the version(s), the license, and the surface(s) it belongs to (see “Surfaces” for what each surface means). It complements — and does not replace — the per-surface license notices: some travel inside a shipped artifact, others are shown by the web frontend’s “About → Open Source” page, which the mobile and desktop shells load at runtime (see “Where license notices, texts, and references live”). The full license texts themselves are not reproduced here.

The gateway plugin is a case worth stating plainly: it is published as source, so its third-party dependencies are not bundled into our tarball but are installed by the operator from npm — the operator obtains each package, and whatever license text it bundles, from npm at install time. They are listed here anyway so the inventory stays complete.

**Scope of build/development tooling.** Dev-only tooling that lives in `devDependencies` (linters, test runners, type checkers, and the like) is a production dependency of nothing and ships in no artifact, so it is out of scope for this inventory. Two honest caveats:

- Some build-flavored packages resolve into the `ui` production dependency closure through `@nuxt/ui` and related packages, so `pnpm licenses --prod` reports them and they appear below on the `ui` surface. Vite and Tailwind are direct `devDependencies` of the `ui` workspace that additionally resolve into that closure; esbuild and Rollup enter it purely as transitive dependencies. Either way they are build-time tools: they do not ship as packages in the web `dist`, and the desktop (Electron) build's `files` whitelist excludes them from `app.asar`, so they carry no `electron` surface.
- `lightningcss` (MPL-2.0) is a build-time CSS transformer whose output is plain CSS; it reaches no shipped artifact. It resolves into the `ui` production closure (hence the `ui` surface below) but is excluded from the desktop `app.asar` by the electron-builder `files` whitelist, so it carries no `electron` surface — it is the only MPL family in the pnpm production trees, and it ships in nothing.

## Surfaces

The **Surfaces** column records the dependency scope(s) a component belongs to. For `server`, `plugin`, `android`, `ios`, and `electron` this coincides with the shipped artifact that carries or installs the component; `ui` is a dependency-*resolution* scope that also includes build-time tooling shipping in no artifact (called out per component where that applies):

- `server` — the CoClaw backend service image.
- `ui` — a member of the `ui` workspace's resolved production dependency set. The web frontend built from this workspace is served over the network; the Android and iOS shells load that frontend at runtime, so its web dependencies reach those clients without being re-bundled per platform. This column reflects production dependency *resolution*, not per-package shipment: it includes build-time tooling that resolves into the production closure but does not itself ship as a package in the web `dist`.
- `plugin` — the OpenClaw gateway plugin published to npm (as source; its dependencies are installed from npm).
- `android` — the Android app’s native layer (Android Maven dependencies plus the native code compiled from Capacitor plugin packages).
- `ios` — the iOS app’s native layer (Swift Package Manager dependencies plus the native code compiled from Capacitor plugin packages).
- `electron` — the desktop app's bundled runtime (Electron / Chromium / Node.js / FFmpeg) plus the desktop shell's own runtime dependency closure bundled into `app.asar` (the five `electron-*` shell packages and their transitive dependencies, 63 packages). The desktop shell loads the web frontend remotely at runtime, so the `ui` production tree and the build toolchain are **not** bundled into `app.asar`; only the shell runtime closure carries an `electron` surface.

A component that ships on several surfaces is listed once, with all carrying surfaces joined.

## Where license notices, texts, and references live

Full license texts are not reproduced in this file. Where each shipped artifact or in-app screen carries a license notice, text, or reference varies by surface, and in some cases (noted below) the license is referenced rather than reproduced in full:

- `ui` (web) — `ui/public/third-party-notices.txt`, surfaced in-app via the “About → Open Source” page (the mobile and desktop shells display the same page).
- `server` — nearly every dependency keeps its own LICENSE file inside `node_modules` in the server image; a couple (`pause`, `cookie-signature`) publish without a standalone LICENSE file but carry the license text in their bundled README, and are called out in this inventory.
- `plugin` — the plugin ships as source, and its dependencies carry their own license texts when installed from npm; a few (the `werift` family, `ip`, `nano-time`, `rx.mini`) publish without an embedded license text and are called out here.
- `android` — the in-app open-source license screen (Google oss-licenses), populated from the release dependency set; some entries carry the full license text, but many reference the upstream license by URL or title only.
- `ios` — the shared web “About → Open Source” page (loaded at runtime by the iOS shell), i.e. `ui/public/third-party-notices.txt`; the two remote SPM packages listed below (`capacitor-swift-pm`, `ion-ios-filesystem`) are included there as manually recorded MIT entries.
- `electron` — `LICENSE.electron.txt` and `LICENSES.chromium.html` bundled inside the desktop package; the FFmpeg / LGPL source-acquisition note is shown on the open-source notice page.

## Base container images

The `server` and `ui` services are published as Docker images to `ghcr.io/coclaw/server` and `ghcr.io/coclaw/ui` (public, anonymously pullable). Each is built on an unmodified official base image:

- `server` — `node:22-slim` (Debian bookworm userland + Node.js 22), with `curl` installed via apt in the final runner image. The Debian base carries system-level components under a mix of licenses, including GPL-3.0-or-later (e.g. bash, coreutils) and LGPL (e.g. glibc).
- `ui` — `busybox:stable`, which serves the static web bundle; BusyBox is licensed GPL-2.0-only.

These base-image components are aggregated with — not linked into — CoClaw’s own code (mere aggregation), and the base images are used unmodified. Their source is available from the respective upstream distributions (Debian, BusyBox, Node.js). They are noted here for completeness rather than enumerated per component. At release time the exact licenses and corresponding-source locations of these base-layer components should be recorded against the pinned per-architecture image manifest / platform digest of each released image; the current build scripts do not yet capture that record, so no exact base-package versions or per-package license conclusions are asserted here.

## Regenerating this document

This inventory is compiled manually (not wired into CI). To refresh it:

1. **pnpm JS components** — run `pnpm licenses list --json --prod` per workspace (`--filter ./server`, `--filter ./ui`, `--filter ./plugins/openclaw`), take the union deduplicated by package name, and drop CoClaw’s own `@coclaw/*` packages. Derive the `electron` surface separately from the desktop build's actual `app.asar` contents — unpack a desktop build and read each bundled package's `name@version` — not from the `ui` tree; the desktop shell bundles only its own runtime closure, not the `ui` production tree.
2. **Android native** — the Google oss-licenses plugin (release configuration) / the release dependency tree; verify each Maven coordinate’s license against its POM.
3. **iOS native** — `ui/ios/App/CapApp-SPM/Package.swift` for the local Capacitor plugin set, and `ui/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved` for the resolved remote SPM package versions.
4. **Desktop runtime** — read the bundled `LICENSE.electron.txt` and `LICENSES.chromium.html` from a desktop build.
5. **Base container images** — the `FROM` lines in `server/Dockerfile` and `ui/Dockerfile`.

---

## pnpm JS components (620)

Deduplicated union of the production dependency trees of the `server`, `ui`, and `plugin` workspaces (`pnpm licenses list --json --prod` per workspace), excluding CoClaw’s own `@coclaw/*` packages (e.g. the in-house `pion` WebRTC fork). A subset of these packages (the Capacitor plugins) also compile native code into the mobile shells and therefore carry `android` / `ios` surfaces. The `electron` surface is carried only by the desktop shell's own runtime closure (63 packages bundled into `app.asar`), not by the whole `ui` tree — see “Surfaces”.

The **License** column records each package's primary license — normally as declared in its npm metadata; a handful of packages publish without a usable declaration and are recorded on other evidence instead (`pause` and `cookie-signature` from the MIT text embedded in their README, `vaul-vue` confirmed MIT from its upstream repository's LICENSE — the published tarball merely omits the license file — and `rx.mini` inferred MIT from its upstream repository, `@shinyoshiaki/jspack` from the BSD-3-Clause LICENSE file in its published tarball — see the notes after the table). Some packages additionally compile individual source files under another (still permissive) license into a shipped binary; those file-level cases are summarized in the file-level license note after the table, with the full per-file copyright lines and license texts reproduced in the applicable per-surface notices (for the mobile/desktop/web clients, `ui/public/third-party-notices.txt`), not in this package-level inventory. **Version sets and surface sets are independent unions**: a version listed for a package does not imply that that specific version appears on every listed surface (where different versions of one package carry different licenses, e.g. `minipass`, `sax`, the license is given per version).

| Component | Version(s) | License | Surfaces |
|---|---|---|---|
| `@alloc/quick-lru` | 5.2.0 | MIT | ui |
| `@antfu/install-pkg` | 1.1.0 | MIT | ui |
| `@babel/helper-string-parser` | 7.27.1 | MIT | server, ui |
| `@babel/helper-validator-identifier` | 7.28.5 | MIT | server, ui |
| `@babel/parser` | 7.29.0 | MIT | server, ui |
| `@babel/runtime` | 7.28.6 | MIT | plugin |
| `@babel/types` | 7.29.0 | MIT | server, ui |
| `@bufbuild/protobuf` | 2.11.0 | (Apache-2.0 AND BSD-3-Clause) | ui |
| `@capacitor/android` | 8.2.0 | MIT | ui, android |
| `@capacitor/app` | 8.0.1 | MIT | ui, android, ios |
| `@capacitor/browser` | 8.0.2 | MIT | ui, android, ios |
| `@capacitor/camera` | 8.0.2 | MIT | ui, android, ios |
| `@capacitor/cli` | 8.2.0 | MIT | ui |
| `@capacitor/clipboard` | 8.0.1 | MIT | ui, android, ios |
| `@capacitor/core` | 8.2.0 | MIT | ui |
| `@capacitor/filesystem` | 8.1.2 | MIT | ui, android, ios |
| `@capacitor/haptics` | 8.0.1 | MIT | ui, android, ios |
| `@capacitor/ios` | 8.2.0 | MIT | ui |
| `@capacitor/keyboard` | 8.0.1 | MIT | ui, android, ios |
| `@capacitor/local-notifications` | 8.0.2 | MIT | ui, android, ios |
| `@capacitor/network` | 8.0.1 | MIT | ui, android, ios |
| `@capacitor/preferences` | 8.0.1 | MIT | ui, android, ios |
| `@capacitor/push-notifications` | 8.0.2 | MIT | ui, android, ios |
| `@capacitor/share` | 8.0.1 | MIT | ui, android, ios |
| `@capacitor/splash-screen` | 8.0.1 | MIT | ui, android, ios |
| `@capacitor/status-bar` | 8.0.1 | MIT | ui, android, ios |
| `@capacitor/synapse` | 1.0.4 | ISC | ui |
| `@capawesome/capacitor-badge` | 8.0.1 | MIT | ui, android, ios |
| `@capsizecss/unpack` | 4.0.0 | MIT | ui |
| `@esbuild/linux-x64` | 0.27.3; 0.27.4 | MIT | ui |
| `@fidm/asn1` | 1.0.4 | MIT | plugin |
| `@fidm/x509` | 1.2.1 | MIT | plugin |
| `@floating-ui/core` | 1.7.4; 1.7.5 | MIT | ui |
| `@floating-ui/dom` | 1.7.5; 1.7.6 | MIT | ui |
| `@floating-ui/utils` | 0.2.10; 0.2.11 | MIT | ui |
| `@floating-ui/vue` | 1.1.11 | MIT | ui |
| `@iconify/collections` | 1.0.652 | MIT | ui |
| `@iconify/types` | 2.0.0 | MIT | ui |
| `@iconify/utils` | 3.1.0 | MIT | ui |
| `@iconify/vue` | 5.0.0 | MIT | ui |
| `@iktakahiro/markdown-it-katex` | 4.0.1 | MIT | ui |
| `@inquirer/ansi` | 2.0.3 | MIT | server |
| `@inquirer/confirm` | 6.0.8 | MIT | server |
| `@inquirer/core` | 11.1.5 | MIT | server |
| `@inquirer/figures` | 2.0.3 | MIT | server |
| `@inquirer/type` | 4.0.3 | MIT | server |
| `@internationalized/date` | 3.11.0 | Apache-2.0 | ui |
| `@internationalized/number` | 3.6.5 | Apache-2.0 | ui |
| `@intlify/core-base` | 10.0.8 | MIT | ui |
| `@intlify/message-compiler` | 10.0.8 | MIT | ui |
| `@intlify/shared` | 10.0.8 | MIT | ui |
| `@ionic/cli-framework-output` | 2.2.8 | MIT | ui |
| `@ionic/utils-array` | 2.1.6 | MIT | ui |
| `@ionic/utils-fs` | 3.1.7 | MIT | ui |
| `@ionic/utils-object` | 2.1.6 | MIT | ui |
| `@ionic/utils-process` | 2.1.12 | MIT | ui |
| `@ionic/utils-stream` | 3.1.7 | MIT | ui |
| `@ionic/utils-subprocess` | 3.0.1 | MIT | ui |
| `@ionic/utils-terminal` | 2.3.5 | MIT | ui |
| `@isaacs/fs-minipass` | 4.0.1 | ISC | ui |
| `@jridgewell/gen-mapping` | 0.3.13 | MIT | ui |
| `@jridgewell/remapping` | 2.3.5 | MIT | ui |
| `@jridgewell/resolve-uri` | 3.1.2 | MIT | ui |
| `@jridgewell/sourcemap-codec` | 1.5.5 | MIT | ui |
| `@jridgewell/trace-mapping` | 0.3.31 | MIT | ui |
| `@leichtgewicht/ip-codec` | 2.0.5 | MIT | plugin |
| `@minhducsun2002/leb128` | 1.0.0 | MIT | plugin |
| `@msgpack/msgpack` | 3.1.3 | ISC | plugin |
| `@noble/curves` | 1.9.7 | MIT | plugin |
| `@noble/hashes` | 1.8.0 | MIT | server, plugin |
| `@nuxt/devtools-kit` | 3.2.1; 3.2.3 | MIT | ui |
| `@nuxt/fonts` | 0.14.0 | MIT | ui |
| `@nuxt/icon` | 2.2.1 | MIT | ui |
| `@nuxt/kit` | 3.21.1; 4.3.1 | MIT | ui |
| `@nuxt/schema` | 4.3.1 | MIT | ui |
| `@nuxt/ui` | 4.5.1 | MIT | ui |
| `@nuxtjs/color-mode` | 3.5.2 | MIT | ui |
| `@paralleldrive/cuid2` | 2.3.1 | MIT | server |
| `@parcel/watcher` | 2.5.6 | MIT | ui |
| `@parcel/watcher-linux-x64-glibc` | 2.5.6 | MIT | ui |
| `@parcel/watcher-linux-x64-musl` | 2.5.6 | MIT | ui |
| `@peculiar/asn1-cms` | 2.6.1 | MIT | plugin |
| `@peculiar/asn1-csr` | 2.6.1 | MIT | plugin |
| `@peculiar/asn1-ecc` | 2.6.1 | MIT | plugin |
| `@peculiar/asn1-pfx` | 2.6.1 | MIT | plugin |
| `@peculiar/asn1-pkcs8` | 2.6.1 | MIT | plugin |
| `@peculiar/asn1-pkcs9` | 2.6.1 | MIT | plugin |
| `@peculiar/asn1-rsa` | 2.6.1 | MIT | plugin |
| `@peculiar/asn1-schema` | 2.6.0 | MIT | plugin |
| `@peculiar/asn1-x509` | 2.6.1 | MIT | plugin |
| `@peculiar/asn1-x509-attr` | 2.6.1 | MIT | plugin |
| `@peculiar/x509` | 1.14.3 | MIT | plugin |
| `@polka/url` | 1.0.0-next.29 | MIT | ui |
| `@prisma/client` | 6.19.0 | Apache-2.0 | server |
| `@prisma/config` | 6.19.0 | Apache-2.0 | server |
| `@prisma/debug` | 6.19.0 | Apache-2.0 | server |
| `@prisma/engines` | 6.19.0 | Apache-2.0 | server |
| `@prisma/engines-version` | 6.19.0-26.2ba551f319ab1df4bc874a89965d8b3641056773 | Apache-2.0 | server |
| `@prisma/fetch-engine` | 6.19.0 | Apache-2.0 | server |
| `@prisma/get-platform` | 6.19.0 | Apache-2.0 | server |
| `@remirror/core-constants` | 3.0.0 | MIT | ui |
| `@rollup/rollup-linux-x64-gnu` | 4.57.1 | MIT | ui |
| `@rollup/rollup-linux-x64-musl` | 4.57.1 | MIT | ui |
| `@shinyoshiaki/binary-data` | 0.6.1 | MIT | plugin |
| `@shinyoshiaki/ebml-builder` | 0.0.1 | MIT | plugin |
| `@shinyoshiaki/jspack` | 0.0.6 | BSD-3-Clause | plugin |
| `@standard-schema/spec` | 1.1.0 | MIT | server, ui |
| `@swc/helpers` | 0.5.18 | Apache-2.0 | ui |
| `@tailwindcss/node` | 4.2.1 | MIT | ui |
| `@tailwindcss/oxide` | 4.2.1 | MIT | ui |
| `@tailwindcss/oxide-linux-x64-gnu` | 4.2.1 | MIT | ui |
| `@tailwindcss/oxide-linux-x64-musl` | 4.2.1 | MIT | ui |
| `@tailwindcss/postcss` | 4.2.1 | MIT | ui |
| `@tailwindcss/vite` | 4.2.1 | MIT | ui |
| `@tanstack/table-core` | 8.21.3 | MIT | ui |
| `@tanstack/virtual-core` | 3.13.22 | MIT | ui |
| `@tanstack/vue-table` | 8.21.3 | MIT | ui |
| `@tanstack/vue-virtual` | 3.13.22 | MIT | ui |
| `@tiptap/core` | 3.20.0 | MIT | ui |
| `@tiptap/extension-blockquote` | 3.20.0 | MIT | ui |
| `@tiptap/extension-bold` | 3.20.0 | MIT | ui |
| `@tiptap/extension-bubble-menu` | 3.20.0 | MIT | ui |
| `@tiptap/extension-bullet-list` | 3.20.0 | MIT | ui |
| `@tiptap/extension-code` | 3.20.0 | MIT | ui |
| `@tiptap/extension-code-block` | 3.20.0 | MIT | ui |
| `@tiptap/extension-collaboration` | 3.20.0 | MIT | ui |
| `@tiptap/extension-document` | 3.20.0 | MIT | ui |
| `@tiptap/extension-drag-handle` | 3.20.0 | MIT | ui |
| `@tiptap/extension-drag-handle-vue-3` | 3.20.0 | MIT | ui |
| `@tiptap/extension-dropcursor` | 3.20.0 | MIT | ui |
| `@tiptap/extension-floating-menu` | 3.20.0 | MIT | ui |
| `@tiptap/extension-gapcursor` | 3.20.0 | MIT | ui |
| `@tiptap/extension-hard-break` | 3.20.0 | MIT | ui |
| `@tiptap/extension-heading` | 3.20.0 | MIT | ui |
| `@tiptap/extension-horizontal-rule` | 3.20.0 | MIT | ui |
| `@tiptap/extension-image` | 3.20.0 | MIT | ui |
| `@tiptap/extension-italic` | 3.20.0 | MIT | ui |
| `@tiptap/extension-link` | 3.20.0 | MIT | ui |
| `@tiptap/extension-list` | 3.20.0 | MIT | ui |
| `@tiptap/extension-list-item` | 3.20.0 | MIT | ui |
| `@tiptap/extension-list-keymap` | 3.20.0 | MIT | ui |
| `@tiptap/extension-mention` | 3.20.0 | MIT | ui |
| `@tiptap/extension-node-range` | 3.20.0 | MIT | ui |
| `@tiptap/extension-ordered-list` | 3.20.0 | MIT | ui |
| `@tiptap/extension-paragraph` | 3.20.0 | MIT | ui |
| `@tiptap/extension-placeholder` | 3.20.0 | MIT | ui |
| `@tiptap/extension-strike` | 3.20.0 | MIT | ui |
| `@tiptap/extension-text` | 3.20.0 | MIT | ui |
| `@tiptap/extension-underline` | 3.20.0 | MIT | ui |
| `@tiptap/extensions` | 3.20.0 | MIT | ui |
| `@tiptap/markdown` | 3.20.0 | MIT | ui |
| `@tiptap/pm` | 3.20.0 | MIT | ui |
| `@tiptap/starter-kit` | 3.20.0 | MIT | ui |
| `@tiptap/suggestion` | 3.20.0 | MIT | ui |
| `@tiptap/vue-3` | 3.20.0 | MIT | ui |
| `@tiptap/y-tiptap` | 3.0.2 | MIT | ui |
| `@types/estree` | 1.0.8 | MIT | ui |
| `@types/fs-extra` | 8.1.5 | MIT | ui |
| `@types/linkify-it` | 5.0.0 | MIT | ui |
| `@types/markdown-it` | 14.1.2 | MIT | ui |
| `@types/mdurl` | 2.0.0 | MIT | ui |
| `@types/node` | 12.20.55; 24.12.0 | MIT | server, ui |
| `@types/slice-ansi` | 4.0.0 | MIT | ui |
| `@types/web-bluetooth` | 0.0.20; 0.0.21 | MIT | ui |
| `@unhead/vue` | 2.1.12 | MIT | ui |
| `@vue/compiler-core` | 3.5.30 | MIT | ui |
| `@vue/compiler-dom` | 3.5.30 | MIT | ui |
| `@vue/compiler-sfc` | 3.5.30 | MIT | ui |
| `@vue/compiler-ssr` | 3.5.30 | MIT | ui |
| `@vue/devtools-api` | 6.6.4; 7.7.9 | MIT | ui |
| `@vue/devtools-kit` | 7.7.9 | MIT | ui |
| `@vue/devtools-shared` | 7.7.9 | MIT | ui |
| `@vue/reactivity` | 3.5.30 | MIT | ui |
| `@vue/runtime-core` | 3.5.30 | MIT | ui |
| `@vue/runtime-dom` | 3.5.30 | MIT | ui |
| `@vue/server-renderer` | 3.5.30 | MIT | ui |
| `@vue/shared` | 3.5.28; 3.5.30 | MIT | ui |
| `@vueuse/core` | 10.11.1; 14.2.1 | MIT | ui |
| `@vueuse/integrations` | 14.2.1 | MIT | ui |
| `@vueuse/metadata` | 10.11.1; 14.2.1 | MIT | ui |
| `@vueuse/shared` | 10.11.1; 14.2.1 | MIT | ui |
| `@xmldom/xmldom` | 0.8.11 | MIT | ui |
| `accepts` | 2.0.0 | MIT | server |
| `acorn` | 8.15.0 | MIT | ui |
| `aes-js` | 3.1.2 | MIT | plugin |
| `ajv` | 8.18.0 | MIT | ui, electron |
| `ajv-formats` | 3.0.1 | MIT | ui, electron |
| `ansi-regex` | 5.0.1; 6.2.2 | MIT | ui, electron |
| `ansi-styles` | 4.3.0; 6.2.3 | MIT | ui, electron |
| `anymatch` | 3.1.3 | ISC | ui |
| `argparse` | 2.0.1 | Python-2.0 | ui, electron |
| `aria-hidden` | 1.2.6 | MIT | ui |
| `asn1js` | 3.0.7 | BSD-3-Clause | plugin |
| `astral-regex` | 2.0.0 | MIT | ui |
| `asynckit` | 0.4.0 | MIT | server, ui |
| `at-least-node` | 1.0.0 | ISC | ui |
| `atomically` | 2.1.1 | MIT | ui, electron |
| `axios` | 1.13.5; 1.13.6 | MIT | server, ui |
| `balanced-match` | 4.0.4 | MIT | ui |
| `base64-js` | 1.5.1 | MIT | ui, plugin |
| `basic-auth` | 2.0.1 | MIT | server |
| `big-integer` | 1.6.52 | Unlicense | ui, plugin |
| `birpc` | 2.9.0 | MIT | ui |
| `body-parser` | 2.2.2 | MIT | server |
| `bplist-parser` | 0.3.2 | MIT | ui |
| `brace-expansion` | 5.0.4 | MIT | ui |
| `buffer` | 6.0.3 | MIT | plugin |
| `buffer-crc32` | 0.2.13; 1.0.0 | MIT | ui, plugin |
| `builder-util-runtime` | 9.5.1 | MIT | ui, electron |
| `bytes` | 3.1.2 | MIT | server |
| `c12` | 3.1.0; 3.3.3 | MIT | server, ui |
| `call-bind-apply-helpers` | 1.0.2 | MIT | server, ui |
| `call-bound` | 1.0.4 | MIT | server |
| `chokidar` | 4.0.3; 5.0.0 | MIT | server, ui |
| `chownr` | 3.0.0 | BlueOak-1.0.0 | ui |
| `citty` | 0.1.6; 0.2.1 | MIT | server, ui |
| `cli-truncate` | 4.0.0 | MIT | ui, electron |
| `cli-width` | 4.1.0 | ISC | server |
| `color-convert` | 2.0.1 | MIT | ui |
| `color-name` | 1.1.4 | MIT | ui |
| `colorjs.io` | 0.5.2 | MIT | ui |
| `colortranslator` | 5.0.0 | Apache-2.0 | ui |
| `combined-stream` | 1.0.8 | MIT | server, ui |
| `commander` | 2.20.3; 12.1.0; 14.0.3 | MIT | server, ui |
| `conf` | 15.1.0 | MIT | ui, electron |
| `confbox` | 0.1.8; 0.2.4 | MIT | server, ui |
| `consola` | 3.4.2 | MIT | server, ui |
| `content-disposition` | 1.0.1 | MIT | server |
| `content-type` | 1.0.5 | MIT | server |
| `cookie` | 0.7.2 | MIT | server |
| `cookie-es` | 1.2.2 | MIT | ui |
| `cookie-signature` | 1.0.7; 1.2.2 | MIT | server |
| `copy-anything` | 4.0.5 | MIT | ui |
| `cors` | 2.8.6 | MIT | server |
| `crelt` | 1.0.6 | MIT | ui |
| `cross-spawn` | 7.0.6 | MIT | ui |
| `crossws` | 0.3.5 | MIT | ui |
| `css-tree` | 3.2.1 | MIT | ui |
| `csstype` | 3.2.3 | MIT | ui |
| `date-fns` | 2.30.0 | MIT | plugin |
| `debounce-fn` | 6.0.0 | MIT | ui, electron |
| `debug` | 2.6.9; 4.4.3 | MIT | server, ui, plugin, electron |
| `deepmerge-ts` | 7.1.5 | BSD-3-Clause | server |
| `define-lazy-prop` | 2.0.0 | MIT | ui |
| `defu` | 6.1.4 | MIT | server, ui |
| `delayed-stream` | 1.0.0 | MIT | server, ui |
| `depd` | 2.0.0 | MIT | server |
| `destr` | 2.0.5 | MIT | server, ui |
| `detect-libc` | 2.1.2 | Apache-2.0 | ui |
| `dns-packet` | 5.6.1 | MIT | plugin |
| `dot-prop` | 10.1.0 | MIT | ui, electron |
| `dotenv` | 16.6.1; 17.3.1 | BSD-2-Clause | server, ui |
| `dunder-proto` | 1.0.1 | MIT | server, ui |
| `ee-first` | 1.1.1 | MIT | server |
| `effect` | 3.18.4 | MIT | server |
| `electron-context-menu` | 4.1.2 | MIT | ui, electron |
| `electron-dl` | 4.0.0 | MIT | ui, electron |
| `electron-is-dev` | 3.0.1 | MIT | ui, electron |
| `electron-log` | 5.4.3 | MIT | ui, electron |
| `electron-store` | 11.0.2 | MIT | ui, electron |
| `electron-updater` | 6.8.3 | MIT | ui, electron |
| `electron-window-state` | 5.0.3 | MIT | ui, electron |
| `elementtree` | 0.1.7 | Apache-2.0 | ui |
| `embla-carousel` | 8.6.0 | MIT | ui |
| `embla-carousel-auto-height` | 8.6.0 | MIT | ui |
| `embla-carousel-auto-scroll` | 8.6.0 | MIT | ui |
| `embla-carousel-autoplay` | 8.6.0 | MIT | ui |
| `embla-carousel-class-names` | 8.6.0 | MIT | ui |
| `embla-carousel-fade` | 8.6.0 | MIT | ui |
| `embla-carousel-reactive-utils` | 8.6.0 | MIT | ui |
| `embla-carousel-vue` | 8.6.0 | MIT | ui |
| `embla-carousel-wheel-gestures` | 8.1.0 | MIT | ui |
| `emoji-regex` | 8.0.0; 10.6.0 | MIT | ui, electron |
| `empathic` | 2.0.0 | MIT | server |
| `encodeurl` | 2.0.0 | MIT | server |
| `enhanced-resolve` | 5.20.0 | MIT | ui |
| `entities` | 4.5.0; 7.0.1 | BSD-2-Clause | ui |
| `env-paths` | 2.2.1; 3.0.0 | MIT | ui, electron |
| `errx` | 0.1.0 | MIT | ui |
| `es-define-property` | 1.0.1 | MIT | server, ui |
| `es-errors` | 1.3.0 | MIT | server, ui |
| `es-object-atoms` | 1.1.1 | MIT | server, ui |
| `es-set-tostringtag` | 2.1.0 | MIT | server, ui |
| `esbuild` | 0.27.3; 0.27.4 | MIT | ui |
| `escape-goat` | 4.0.0 | MIT | ui, electron |
| `escape-html` | 1.0.3 | MIT | server |
| `escape-string-regexp` | 4.0.0; 5.0.0 | MIT | ui, electron |
| `estree-walker` | 2.0.2; 3.0.3 | MIT | ui |
| `etag` | 1.8.1 | MIT | server |
| `execa` | 8.0.1 | MIT | ui |
| `express` | 5.2.1 | MIT | server |
| `express-session` | 1.19.0 | MIT | server |
| `exsolve` | 1.0.8 | MIT | server, ui |
| `ext-list` | 2.2.2 | MIT | ui, electron |
| `ext-name` | 5.0.0 | MIT | ui, electron |
| `fast-check` | 3.23.2 | MIT | server |
| `fast-deep-equal` | 3.1.3 | MIT | ui, electron |
| `fast-string-truncated-width` | 3.0.3 | MIT | server |
| `fast-string-width` | 3.0.2 | MIT | server |
| `fast-uri` | 3.1.0 | BSD-3-Clause | ui, electron |
| `fast-wrap-ansi` | 0.2.0 | MIT | server |
| `fd-slicer` | 1.1.0 | MIT | ui |
| `fdir` | 6.5.0 | MIT | ui |
| `finalhandler` | 2.1.1 | MIT | server |
| `follow-redirects` | 1.15.11 | MIT | server, ui |
| `fontaine` | 0.8.0 | MIT | ui |
| `fontkitten` | 1.0.3 | MIT | ui |
| `fontless` | 0.2.1 | MIT | ui |
| `form-data` | 4.0.5 | MIT | server, ui |
| `forwarded` | 0.2.0 | MIT | server |
| `framer-motion` | 12.34.3 | MIT | ui |
| `fresh` | 2.0.0 | MIT | server |
| `fs-extra` | 9.1.0; 10.1.0; 11.3.4 | MIT | ui, electron |
| `function-bind` | 1.1.2 | MIT | server, ui |
| `fuse.js` | 7.1.0 | Apache-2.0 | ui |
| `generate-function` | 2.3.1 | MIT | plugin |
| `get-east-asian-width` | 1.6.0 | MIT | ui, electron |
| `get-intrinsic` | 1.3.0 | MIT | server, ui |
| `get-proto` | 1.0.1 | MIT | server, ui |
| `get-stream` | 8.0.1 | MIT | ui |
| `giget` | 2.0.0 | MIT | server, ui |
| `glob` | 13.0.6 | BlueOak-1.0.0 | ui |
| `gopd` | 1.2.0 | MIT | server, ui |
| `graceful-fs` | 4.2.11 | ISC | ui, electron |
| `h3` | 1.15.6 | MIT | ui |
| `has-flag` | 3.0.0; 4.0.0 | MIT | server, ui, plugin |
| `has-symbols` | 1.1.0 | MIT | server, ui |
| `has-tostringtag` | 1.0.2 | MIT | server, ui |
| `hasown` | 2.0.2 | MIT | server, ui |
| `helmet` | 8.1.0 | MIT | server |
| `hey-listen` | 1.0.8 | MIT | ui |
| `highlight.js` | 11.11.1 | BSD-3-Clause | ui |
| `hookable` | 5.5.3; 6.0.1 | MIT | ui |
| `http-errors` | 2.0.1 | MIT | server |
| `human-signals` | 5.0.0 | Apache-2.0 | ui |
| `iconv-lite` | 0.7.2 | MIT | server |
| `ieee754` | 1.2.1 | BSD-3-Clause | plugin |
| `ignore` | 7.0.5 | MIT | ui |
| `immutable` | 5.1.5 | MIT | ui |
| `inherits` | 2.0.4 | ISC | server, ui |
| `ini` | 4.1.3 | ISC | ui |
| `int64-buffer` | 1.1.0 | MIT | plugin |
| `ip` | 2.0.1 | MIT | plugin |
| `ipaddr.js` | 1.9.1 | MIT | server |
| `iron-webcrypto` | 1.2.1 | MIT | ui |
| `is-docker` | 2.2.1 | MIT | ui |
| `is-extglob` | 2.1.1 | MIT | ui |
| `is-fullwidth-code-point` | 3.0.0; 4.0.0 | MIT | ui, electron |
| `is-glob` | 4.0.3 | MIT | ui |
| `is-plain-obj` | 1.1.0 | MIT | ui, electron |
| `is-plain-object` | 2.0.4 | MIT | plugin |
| `is-promise` | 4.0.0 | MIT | server |
| `is-property` | 1.0.2 | MIT | plugin |
| `is-stream` | 3.0.0 | MIT | ui |
| `is-what` | 5.5.0 | MIT | ui |
| `is-wsl` | 2.2.0 | MIT | ui |
| `isexe` | 2.0.0 | ISC | ui |
| `isobject` | 3.0.1 | MIT | plugin |
| `isomorphic.js` | 0.2.5 | MIT | ui |
| `jiti` | 2.6.1 | MIT | server, ui |
| `js-tokens` | 9.0.1 | MIT | ui |
| `js-yaml` | 4.1.1 | MIT | ui, electron |
| `json-schema-traverse` | 1.0.0 | MIT | ui, electron |
| `json-schema-typed` | 8.0.2 | BSD-2-Clause | ui, electron |
| `jsonfile` | 4.0.0; 6.2.0 | MIT | ui, electron |
| `katex` | 0.12.0 | MIT | ui |
| `kleur` | 3.0.3; 4.1.5 | MIT | ui |
| `klona` | 2.0.6 | MIT | ui |
| `knitwork` | 1.3.0 | MIT | ui |
| `lazy-val` | 1.0.5 | MIT | ui, electron |
| `lib0` | 0.2.117 | MIT | ui |
| `lightningcss` | 1.31.1; 1.32.0 | MPL-2.0 | ui |
| `lightningcss-linux-x64-gnu` | 1.31.1; 1.32.0 | MPL-2.0 | ui |
| `lightningcss-linux-x64-musl` | 1.31.1; 1.32.0 | MPL-2.0 | ui |
| `linkify-it` | 5.0.0 | MIT | ui |
| `linkifyjs` | 4.3.2 | MIT | ui |
| `local-pkg` | 1.1.2 | MIT | ui |
| `lodash` | 4.17.23 | MIT | plugin |
| `lodash.escaperegexp` | 4.1.2 | MIT | ui, electron |
| `lodash.isequal` | 4.5.0 | MIT | ui, electron |
| `lodash.memoize` | 4.1.2 | MIT | plugin |
| `lru-cache` | 11.2.6 | BlueOak-1.0.0 | ui |
| `magic-regexp` | 0.10.0 | MIT | ui |
| `magic-string` | 0.30.21 | MIT | ui |
| `magicast` | 0.3.5 | MIT | server, ui |
| `markdown-it` | 14.1.1 | MIT | ui |
| `markdown-it-link-attributes` | 4.0.1 | MIT | ui |
| `marked` | 17.0.3 | MIT | ui |
| `math-intrinsics` | 1.1.0 | MIT | server, ui |
| `mdn-data` | 2.27.1 | CC0-1.0 | ui |
| `mdurl` | 2.0.0 | MIT | ui |
| `media-typer` | 1.1.0 | MIT | server |
| `merge-descriptors` | 2.0.0 | MIT | server |
| `merge-stream` | 2.0.0 | MIT | ui |
| `mime-db` | 1.52.0; 1.54.0 | MIT | server, ui, electron |
| `mime-types` | 2.1.35; 3.0.2 | MIT | server, ui |
| `mimic-fn` | 4.0.0 | MIT | ui |
| `mimic-function` | 5.0.1 | MIT | ui, electron |
| `minimatch` | 10.2.4 | BlueOak-1.0.0 | ui |
| `minimist` | 1.2.8 | MIT | ui, electron |
| `minipass` | 7.1.2; 7.1.3 | ISC (7.1.2); BlueOak-1.0.0 (7.1.3) | ui |
| `minizlib` | 3.1.0 | MIT | ui |
| `mitt` | 3.0.1 | MIT | ui |
| `mkdirp` | 0.5.6 | MIT | ui, electron |
| `mlly` | 1.8.0 | MIT | ui |
| `morgan` | 1.10.1 | MIT | server |
| `motion-dom` | 12.34.3 | MIT | ui |
| `motion-utils` | 12.29.2 | MIT | ui |
| `motion-v` | 1.10.3 | MIT | ui |
| `mp4box` | 0.5.4 | BSD-3-Clause | plugin |
| `mrmime` | 2.0.1 | MIT | ui |
| `ms` | 2.0.0; 2.1.3 | MIT | server, ui, plugin, electron |
| `multicast-dns` | 7.2.5 | MIT | plugin |
| `mute-stream` | 3.0.0 | ISC | server |
| `nano-time` | 1.0.0 | ISC | plugin |
| `nanoid` | 3.3.11; 5.1.11 | MIT | ui |
| `native-run` | 2.0.3 | MIT | ui |
| `negotiator` | 1.0.0 | MIT | server |
| `node-addon-api` | 7.1.1 | MIT | ui |
| `node-fetch-native` | 1.6.7 | MIT | server, ui |
| `node-mock-http` | 1.0.4 | MIT | ui |
| `normalize-path` | 3.0.0 | MIT | ui |
| `npm-run-path` | 5.3.0 | MIT | ui |
| `nypm` | 0.6.5 | MIT | server, ui |
| `object-assign` | 4.1.1 | MIT | server |
| `object-inspect` | 1.13.4 | MIT | server |
| `obug` | 2.1.1 | MIT | ui |
| `ofetch` | 1.5.1 | MIT | ui |
| `ohash` | 2.0.11 | MIT | server, ui |
| `on-finished` | 2.3.0; 2.4.1 | MIT | server |
| `on-headers` | 1.1.0 | MIT | server |
| `once` | 1.4.0 | ISC | server |
| `onetime` | 6.0.0 | MIT | ui |
| `open` | 8.4.2 | MIT | ui |
| `orderedmap` | 2.1.1 | MIT | ui |
| `p-cancelable` | 2.1.1 | MIT | plugin |
| `package-json-from-dist` | 1.0.1 | BlueOak-1.0.0 | ui |
| `package-manager-detector` | 1.6.0 | MIT | ui |
| `parseurl` | 1.3.3 | MIT | server |
| `passport` | 0.7.0 | MIT | server |
| `passport-local` | 1.0.0 | MIT | server |
| `passport-strategy` | 1.0.0 | MIT | server |
| `path-exists` | 5.0.0 | MIT | ui, electron |
| `path-key` | 3.1.1; 4.0.0 | MIT | ui |
| `path-scurry` | 2.0.2 | BlueOak-1.0.0 | ui |
| `path-to-regexp` | 8.3.0 | MIT | server |
| `pathe` | 1.1.2; 2.0.3 | MIT | server, ui |
| `pause` | 0.0.1 | MIT | server |
| `pend` | 1.2.0 | MIT | ui |
| `perfect-debounce` | 1.0.0; 2.1.0 | MIT | server, ui |
| `picocolors` | 1.1.1 | ISC | ui |
| `picomatch` | 2.3.1; 4.0.3 | MIT | ui |
| `pinia` | 3.0.4 | MIT | ui |
| `pkg-types` | 1.3.1; 2.3.0 | MIT | server, ui |
| `plist` | 3.1.0 | MIT | ui |
| `postcss` | 8.5.8 | MIT | ui |
| `prisma` | 6.19.0 | Apache-2.0 | server |
| `prompts` | 2.4.2 | MIT | ui |
| `prosemirror-changeset` | 2.4.0 | MIT | ui |
| `prosemirror-collab` | 1.3.1 | MIT | ui |
| `prosemirror-commands` | 1.7.1 | MIT | ui |
| `prosemirror-dropcursor` | 1.8.2 | MIT | ui |
| `prosemirror-gapcursor` | 1.4.0 | MIT | ui |
| `prosemirror-history` | 1.5.0 | MIT | ui |
| `prosemirror-inputrules` | 1.5.1 | MIT | ui |
| `prosemirror-keymap` | 1.2.3 | MIT | ui |
| `prosemirror-markdown` | 1.13.4 | MIT | ui |
| `prosemirror-menu` | 1.3.0 | MIT | ui |
| `prosemirror-model` | 1.25.4 | MIT | ui |
| `prosemirror-schema-basic` | 1.2.4 | MIT | ui |
| `prosemirror-schema-list` | 1.5.1 | MIT | ui |
| `prosemirror-state` | 1.4.4 | MIT | ui |
| `prosemirror-tables` | 1.8.5 | MIT | ui |
| `prosemirror-trailing-node` | 3.0.0 | MIT | ui |
| `prosemirror-transform` | 1.11.0 | MIT | ui |
| `prosemirror-view` | 1.41.6 | MIT | ui |
| `proxy-addr` | 2.0.7 | MIT | server |
| `proxy-from-env` | 1.1.0 | MIT | server, ui |
| `punycode.js` | 2.3.1 | MIT | ui |
| `pupa` | 3.3.0 | MIT | ui, electron |
| `pure-rand` | 6.1.0 | MIT | server |
| `pvtsutils` | 1.3.6 | MIT | plugin |
| `pvutils` | 1.1.5 | MIT | plugin |
| `qs` | 6.15.0 | BSD-3-Clause | server |
| `quansync` | 0.2.11 | MIT | ui |
| `radix3` | 1.1.2 | MIT | ui |
| `random-bytes` | 1.0.0 | MIT | server |
| `range-parser` | 1.2.1 | MIT | server |
| `raw-body` | 3.0.2 | MIT | server |
| `rc9` | 2.1.2; 3.0.0 | MIT | server, ui |
| `readable-stream` | 3.6.2 | MIT | ui |
| `readdirp` | 4.1.2; 5.0.0 | MIT | server, ui |
| `reflect-metadata` | 0.2.2 | Apache-2.0 | plugin |
| `regexp-tree` | 0.1.27 | MIT | ui |
| `reka-ui` | 2.8.2 | MIT | ui |
| `require-from-string` | 2.0.2 | MIT | ui, electron |
| `rfdc` | 1.4.1 | MIT | ui |
| `rimraf` | 6.1.3 | BlueOak-1.0.0 | ui |
| `rollup` | 4.57.1 | MIT | ui |
| `rope-sequence` | 1.3.4 | MIT | ui |
| `router` | 2.2.0 | MIT | server |
| `rx.mini` | 1.4.0 | MIT | plugin |
| `rxjs` | 7.8.2 | Apache-2.0 | ui |
| `safe-buffer` | 5.1.2; 5.2.1 | MIT | server, ui |
| `safer-buffer` | 2.1.2 | MIT | server |
| `sass` | 1.98.0 | MIT | ui |
| `sass-embedded` | 1.98.0 | MIT | ui |
| `sass-embedded-linux-musl-x64` | 1.98.0 | MIT | ui |
| `sass-embedded-linux-x64` | 1.98.0 | MIT | ui |
| `sax` | 1.1.4; 1.5.0 | ISC (1.1.4); BlueOak-1.0.0 (1.5.0) | ui, electron |
| `scule` | 1.3.0 | MIT | ui |
| `semver` | 7.7.4 | ISC | ui, electron |
| `send` | 1.2.1 | MIT | server |
| `serve-static` | 2.2.1 | MIT | server |
| `setprototypeof` | 1.2.0 | ISC | server |
| `shebang-command` | 2.0.0 | MIT | ui |
| `shebang-regex` | 3.0.0 | MIT | ui |
| `side-channel` | 1.1.0 | MIT | server |
| `side-channel-list` | 1.0.0 | MIT | server |
| `side-channel-map` | 1.0.1 | MIT | server |
| `side-channel-weakmap` | 1.0.2 | MIT | server |
| `signal-exit` | 3.0.7; 4.1.0 | ISC | server, ui |
| `sirv` | 3.0.2 | MIT | ui |
| `sisteransi` | 1.0.5 | MIT | ui |
| `slice-ansi` | 4.0.0; 5.0.0 | MIT | ui, electron |
| `sort-keys` | 1.1.2 | MIT | ui, electron |
| `sort-keys-length` | 1.0.1 | MIT | ui, electron |
| `source-map-js` | 1.2.1 | BSD-3-Clause | server, ui |
| `speakingurl` | 14.0.1 | BSD-3-Clause | ui |
| `split2` | 4.2.0 | ISC | ui |
| `statuses` | 2.0.2 | MIT | server |
| `std-env` | 3.10.0 | MIT | ui |
| `string-width` | 4.2.3; 7.2.0 | MIT | ui, electron |
| `string_decoder` | 1.3.0 | MIT | ui |
| `strip-ansi` | 6.0.1; 7.1.2 | MIT | ui, electron |
| `strip-final-newline` | 3.0.0 | MIT | ui |
| `strip-literal` | 3.1.0 | MIT | ui |
| `stubborn-fs` | 2.0.0 | MIT | ui, electron |
| `stubborn-utils` | 1.0.2 | MIT | ui, electron |
| `superjson` | 2.2.6 | MIT | ui |
| `supports-color` | 5.5.0; 8.1.1 | MIT | server, ui, plugin |
| `sync-child-process` | 1.0.2 | MIT | ui |
| `sync-message-port` | 1.2.0 | MIT | ui |
| `tagged-tag` | 1.0.0 | MIT | ui, electron |
| `tailwind-merge` | 3.5.0 | MIT | ui |
| `tailwind-variants` | 3.2.2 | MIT | ui |
| `tailwindcss` | 4.2.1 | MIT | ui |
| `tapable` | 2.3.0 | MIT | ui |
| `tar` | 7.5.10 | BlueOak-1.0.0 | ui |
| `through2` | 4.0.2 | MIT | ui |
| `thunky` | 1.1.0 | MIT | plugin |
| `tiny-inflate` | 1.0.3 | MIT | ui |
| `tiny-typed-emitter` | 2.1.0 | MIT | ui, electron |
| `tinyexec` | 1.0.2 | MIT | server, ui |
| `tinyglobby` | 0.2.15 | MIT | ui |
| `toidentifier` | 1.0.1 | MIT | server |
| `totalist` | 3.0.1 | MIT | ui |
| `tree-kill` | 1.2.2 | MIT | ui |
| `tslib` | 1.14.1; 2.8.1 | 0BSD | ui, plugin |
| `tsyringe` | 4.10.0 | MIT | plugin |
| `turbo-crc32` | 1.0.1 | MIT | plugin |
| `tweetnacl` | 1.0.3 | Unlicense | plugin |
| `type-fest` | 5.4.4 | (MIT OR CC0-1.0) | ui, electron |
| `type-is` | 2.0.1 | MIT | server |
| `type-level-regexp` | 0.1.17 | MIT | ui |
| `typescript` | 5.9.3 | Apache-2.0 | server, ui |
| `uc.micro` | 2.1.0 | MIT | ui |
| `ufo` | 1.6.3 | MIT | ui |
| `uid-safe` | 2.1.5 | MIT | server |
| `uint8array-extras` | 1.5.0 | MIT | ui, electron |
| `uncrypto` | 0.1.3 | MIT | ui |
| `unctx` | 2.5.0 | MIT | ui |
| `undici-types` | 7.16.0 | MIT | server, ui |
| `unhead` | 2.1.12 | MIT | ui |
| `unifont` | 0.7.4 | MIT | ui |
| `unimport` | 5.6.0 | MIT | ui |
| `universalify` | 2.0.1 | MIT | ui, electron |
| `unpipe` | 1.0.0 | MIT | server |
| `unplugin` | 2.3.11; 3.0.0 | MIT | ui |
| `unplugin-auto-import` | 21.0.0 | MIT | ui |
| `unplugin-utils` | 0.3.1 | MIT | ui |
| `unplugin-vue-components` | 31.0.0 | MIT | ui |
| `unstorage` | 1.17.4 | MIT | ui |
| `untildify` | 4.0.0 | MIT | ui |
| `untyped` | 2.0.0 | MIT | ui |
| `unused-filename` | 4.0.1 | MIT | ui, electron |
| `util-deprecate` | 1.0.2 | MIT | ui |
| `utils-merge` | 1.0.1 | MIT | server |
| `uuid` | 9.0.1 | MIT | plugin |
| `varint` | 6.0.0 | MIT | ui |
| `vary` | 1.1.2 | MIT | server |
| `vaul-vue` | 0.4.1 | MIT | ui |
| `vite` | 7.3.1 | MIT | ui |
| `vue` | 3.5.30 | MIT | ui |
| `vue-component-type-helpers` | 3.2.5 | MIT | ui |
| `vue-demi` | 0.14.10 | MIT | ui |
| `vue-i18n` | 10.0.8 | MIT | ui |
| `vue-router` | 4.6.4 | MIT | ui |
| `w3c-keyname` | 2.2.8 | MIT | ui |
| `wavesurfer.js` | 7.12.2 | BSD-3-Clause | ui |
| `webpack-virtual-modules` | 0.6.2 | MIT | ui |
| `werift` | 0.19.9 | MIT | plugin |
| `werift-common` | 0.0.3 | MIT | plugin |
| `werift-dtls` | 0.5.7 | MIT | plugin |
| `werift-ice` | 0.2.2 | MIT | plugin |
| `werift-rtp` | 0.8.8 | MIT | plugin |
| `werift-sctp` | 0.0.11 | MIT | plugin |
| `wheel-gestures` | 2.2.48 | MIT | ui |
| `when-exit` | 2.1.5 | MIT | ui, electron |
| `which` | 2.0.2 | ISC | ui |
| `wrap-ansi` | 7.0.0 | MIT | ui |
| `wrappy` | 1.0.2 | ISC | server |
| `ws` | 8.19.0 | MIT | server, plugin |
| `xml2js` | 0.6.2 | MIT | ui |
| `xmlbuilder` | 11.0.1; 15.1.1 | MIT | ui |
| `y-protocols` | 1.0.7 | MIT | ui |
| `yallist` | 5.0.0 | BlueOak-1.0.0 | ui |
| `yauzl` | 2.10.0 | MIT | ui |
| `yjs` | 13.6.29 | MIT | ui |
| `zod` | 4.3.6 | MIT | server, ui |

**File-level license notes.** Beyond each package's own MIT license, several Capacitor packages compile individual source files under a different (still permissive) license into a shipped mobile binary:

- `@capacitor/android` — a few Java source files compiled into the Android APK carry an Apache-2.0 header (Android Open Source Project / Google), e.g. `UriMatcher.java`, `WebViewLocalServer.java`.
- `@capacitor/network` — one Swift source file compiled into the iOS IPA carries a BSD-2-Clause header, `ios/Sources/NetworkPlugin/Reachability.swift` (Copyright (c) 2014, Ashley Mills).
- `@capacitor/ios`, `@capacitor/keyboard`, `@capacitor/core` — Apache Cordova compatibility sources under Apache-2.0: the Cordova `CDV*` / `NSDictionary+CordovaPreferences` classes and `Keyboard.m` compiled into the iOS IPA, and `cordova.js` shipped in the native app builds. These files carry the ASF licensing statement rather than a per-file copyright line.

The full attribution for every such file — copyright lines (or the ASF statement, where the files carry no copyright line) plus license terms — is reproduced as file-level entries in `ui/public/third-party-notices.txt`, which the mobile and desktop shells reach via the “About → Open Source” page. This package-level inventory neither enumerates each file nor reproduces the texts.

**Packages published without a standalone license file.** A handful of packages publish a tarball with no license field and no standalone LICENSE file. They fall into two cases:

- `pause` (0.0.1) — ships in the server image; the `package.json` has no license field, but the bundled README contains the full MIT license text and copyright, so it is recorded as MIT on that basis (not inferred). `cookie-signature` is similar (its README embeds the MIT text; version 1.2.2 also ships a standalone LICENSE file).
- `rx.mini` (1.4.0) — a plugin dependency; the published tarball carries no license field, no license file, and no license text. Its MIT is inferred from the upstream repository — weaker evidence than `vaul-vue`, whose upstream additionally carries a LICENSE file that the published tarball merely omits. Its bytes are not bundled into any CoClaw artifact — the plugin ships as source and installs it from npm.

(`@shinyoshiaki/jspack` publishes a BSD-3-Clause LICENSE file, so it is recorded directly.)

---

## Android native — Maven (103)

Runtime Maven coordinates that ship inside the APK, each license verified against its POM (a few via the parent POM, or the upstream LICENSE link where the POM only references it). Eight Play Services / Firebase components use Google's proprietary Android SDK license rather than an open-source license; they are labelled `Android SDK License (proprietary)` and marked as such below.

| Component (groupId:artifactId) | Version | License | Surface |
|---|---|---|---|
| `androidx.activity:activity-ktx` | 1.11.0 | Apache-2.0 | android |
| `androidx.activity:activity` | 1.11.0 | Apache-2.0 | android |
| `androidx.annotation:annotation-experimental` | 1.4.1 | Apache-2.0 | android |
| `androidx.annotation:annotation-jvm` | 1.8.1 | Apache-2.0 | android |
| `androidx.appcompat:appcompat-resources` | 1.7.1 | Apache-2.0 | android |
| `androidx.appcompat:appcompat` | 1.7.1 | Apache-2.0 | android |
| `androidx.arch.core:core-common` | 2.2.0 | Apache-2.0 | android |
| `androidx.arch.core:core-runtime` | 2.2.0 | Apache-2.0 | android |
| `androidx.browser:browser` | 1.9.0 | Apache-2.0 | android |
| `androidx.cardview:cardview` | 1.0.0 | Apache-2.0 | android |
| `androidx.collection:collection-jvm` | 1.4.2 | Apache-2.0 | android |
| `androidx.concurrent:concurrent-futures` | 1.1.0 | Apache-2.0 | android |
| `androidx.constraintlayout:constraintlayout-core` | 1.0.0 | Apache-2.0 | android |
| `androidx.constraintlayout:constraintlayout` | 2.1.0 | Apache-2.0 | android |
| `androidx.coordinatorlayout:coordinatorlayout` | 1.3.0 | Apache-2.0 | android |
| `androidx.core:core-ktx` | 1.17.0 | Apache-2.0 | android |
| `androidx.core:core-splashscreen` | 1.2.0 | Apache-2.0 | android |
| `androidx.core:core-viewtree` | 1.0.0 | Apache-2.0 | android |
| `androidx.core:core` | 1.17.0 | Apache-2.0 | android |
| `androidx.cursoradapter:cursoradapter` | 1.0.0 | Apache-2.0 | android |
| `androidx.customview:customview` | 1.1.0 | Apache-2.0 | android |
| `androidx.datastore:datastore-android` | 1.1.7 | Apache-2.0 | android |
| `androidx.datastore:datastore-core-android` | 1.1.7 | Apache-2.0 | android |
| `androidx.datastore:datastore-core-okio-jvm` | 1.1.7 | Apache-2.0 | android |
| `androidx.datastore:datastore-preferences-android` | 1.1.7 | Apache-2.0 | android |
| `androidx.datastore:datastore-preferences-core-android` | 1.1.7 | Apache-2.0 | android |
| `androidx.datastore:datastore-preferences-external-protobuf` | 1.1.7 | BSD-3-Clause | android |
| `androidx.datastore:datastore-preferences-proto` | 1.1.7 | Apache-2.0 | android |
| `androidx.documentfile:documentfile` | 1.0.0 | Apache-2.0 | android |
| `androidx.drawerlayout:drawerlayout` | 1.1.1 | Apache-2.0 | android |
| `androidx.dynamicanimation:dynamicanimation` | 1.1.0 | Apache-2.0 | android |
| `androidx.emoji2:emoji2-views-helper` | 1.3.0 | Apache-2.0 | android |
| `androidx.emoji2:emoji2` | 1.3.0 | Apache-2.0 | android |
| `androidx.exifinterface:exifinterface` | 1.4.1 | Apache-2.0 | android |
| `androidx.fragment:fragment` | 1.8.9 | Apache-2.0 | android |
| `androidx.graphics:graphics-shapes-android` | 1.0.1 | Apache-2.0 | android |
| `androidx.interpolator:interpolator` | 1.0.0 | Apache-2.0 | android |
| `androidx.legacy:legacy-support-core-utils` | 1.0.0 | Apache-2.0 | android |
| `androidx.lifecycle:lifecycle-common` | 2.6.2 | Apache-2.0 | android |
| `androidx.lifecycle:lifecycle-livedata-core` | 2.6.2 | Apache-2.0 | android |
| `androidx.lifecycle:lifecycle-livedata` | 2.6.2 | Apache-2.0 | android |
| `androidx.lifecycle:lifecycle-process` | 2.6.2 | Apache-2.0 | android |
| `androidx.lifecycle:lifecycle-runtime-ktx` | 2.6.2 | Apache-2.0 | android |
| `androidx.lifecycle:lifecycle-runtime` | 2.6.2 | Apache-2.0 | android |
| `androidx.lifecycle:lifecycle-viewmodel-ktx` | 2.6.2 | Apache-2.0 | android |
| `androidx.lifecycle:lifecycle-viewmodel-savedstate` | 2.6.2 | Apache-2.0 | android |
| `androidx.lifecycle:lifecycle-viewmodel` | 2.6.2 | Apache-2.0 | android |
| `androidx.loader:loader` | 1.0.0 | Apache-2.0 | android |
| `androidx.localbroadcastmanager:localbroadcastmanager` | 1.0.0 | Apache-2.0 | android |
| `androidx.print:print` | 1.0.0 | Apache-2.0 | android |
| `androidx.profileinstaller:profileinstaller` | 1.4.0 | Apache-2.0 | android |
| `androidx.recyclerview:recyclerview` | 1.2.1 | Apache-2.0 | android |
| `androidx.resourceinspection:resourceinspection-annotation` | 1.0.1 | Apache-2.0 | android |
| `androidx.savedstate:savedstate-ktx` | 1.2.1 | Apache-2.0 | android |
| `androidx.savedstate:savedstate` | 1.2.1 | Apache-2.0 | android |
| `androidx.startup:startup-runtime` | 1.1.1 | Apache-2.0 | android |
| `androidx.tracing:tracing` | 1.2.0 | Apache-2.0 | android |
| `androidx.transition:transition` | 1.5.0 | Apache-2.0 | android |
| `androidx.vectordrawable:vectordrawable-animated` | 1.1.0 | Apache-2.0 | android |
| `androidx.vectordrawable:vectordrawable` | 1.1.0 | Apache-2.0 | android |
| `androidx.versionedparcelable:versionedparcelable` | 1.1.1 | Apache-2.0 | android |
| `androidx.viewpager2:viewpager2` | 1.0.0 | Apache-2.0 | android |
| `androidx.viewpager:viewpager` | 1.0.0 | Apache-2.0 | android |
| `androidx.webkit:webkit` | 1.14.0 | Apache-2.0 | android |
| `com.google.android.datatransport:transport-api` | 3.1.0 | Apache-2.0 | android |
| `com.google.android.datatransport:transport-backend-cct` | 3.1.9 | Apache-2.0 | android |
| `com.google.android.datatransport:transport-runtime` | 3.1.9 | Apache-2.0 | android |
| `com.google.android.gms:play-services-base` | 18.5.0 | Android SDK License (proprietary) | android |
| `com.google.android.gms:play-services-basement` | 18.4.0 | Android SDK License (proprietary) | android |
| `com.google.android.gms:play-services-cloud-messaging` | 17.2.0 | Android SDK License (proprietary) | android |
| `com.google.android.gms:play-services-oss-licenses` | 17.1.0 | Android SDK License (proprietary) | android |
| `com.google.android.gms:play-services-stats` | 17.0.2 | Android SDK License (proprietary) | android |
| `com.google.android.gms:play-services-tasks` | 18.2.0 | Android SDK License (proprietary) | android |
| `com.google.android.material:material` | 1.13.0 | Apache-2.0 | android |
| `com.google.errorprone:error_prone_annotations` | 2.26.0 | Apache-2.0 | android |
| `com.google.firebase:firebase-annotations` | 17.0.0 | Apache-2.0 | android |
| `com.google.firebase:firebase-common` | 22.0.1 | Apache-2.0 | android |
| `com.google.firebase:firebase-components` | 19.0.0 | Apache-2.0 | android |
| `com.google.firebase:firebase-datatransport` | 18.2.0 | Apache-2.0 | android |
| `com.google.firebase:firebase-encoders-json` | 18.0.0 | Apache-2.0 | android |
| `com.google.firebase:firebase-encoders-proto` | 16.0.0 | Apache-2.0 | android |
| `com.google.firebase:firebase-encoders` | 17.0.0 | Apache-2.0 | android |
| `com.google.firebase:firebase-iid-interop` | 17.1.0 | Android SDK License (proprietary) | android |
| `com.google.firebase:firebase-installations-interop` | 17.1.1 | Apache-2.0 | android |
| `com.google.firebase:firebase-installations` | 18.0.0 | Apache-2.0 | android |
| `com.google.firebase:firebase-measurement-connector` | 19.0.0 | Android SDK License (proprietary) | android |
| `com.google.firebase:firebase-messaging` | 25.0.1 | Apache-2.0 | android |
| `com.google.guava:listenablefuture` | 1.0 | Apache-2.0 | android |
| `com.squareup.okio:okio-jvm` | 3.4.0 | Apache-2.0 | android |
| `io.ionic.libs:ionfilesystem-android` | 1.1.0 | MIT | android |
| `javax.inject:javax.inject` | 1 | Apache-2.0 | android |
| `me.leolin:ShortcutBadger` | 1.1.22 | Apache-2.0 | android |
| `org.apache.cordova:framework` | 14.0.1 | Apache-2.0 | android |
| `org.jetbrains.kotlin:kotlin-android-extensions-runtime` | 1.9.22 | Apache-2.0 | android |
| `org.jetbrains.kotlin:kotlin-parcelize-runtime` | 1.9.22 | Apache-2.0 | android |
| `org.jetbrains.kotlin:kotlin-stdlib-jdk7` | 1.8.22 | Apache-2.0 | android |
| `org.jetbrains.kotlin:kotlin-stdlib-jdk8` | 1.8.22 | Apache-2.0 | android |
| `org.jetbrains.kotlin:kotlin-stdlib` | 2.2.20 | Apache-2.0 | android |
| `org.jetbrains.kotlinx:kotlinx-coroutines-android` | 1.10.2 | Apache-2.0 | android |
| `org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm` | 1.10.2 | Apache-2.0 | android |
| `org.jetbrains.kotlinx:kotlinx-coroutines-play-services` | 1.10.2 | Apache-2.0 | android |
| `org.jetbrains:annotations` | 23.0.0 | Apache-2.0 | android |
| `org.jspecify:jspecify` | 1.0.0 | Apache-2.0 | android |

---

## iOS native — Swift Package Manager (2 remote)

Remote SPM packages fetched for the iOS shell (not part of the pnpm tree). In addition, 15 Capacitor plugin npm packages (all MIT, listed in the pnpm table above with an `ios` surface) compile their own iOS native Swift/Objective-C code into the IPA. The iOS native layer contains no proprietary SDKs and no copyleft components.

| Component | Version | License | Surface |
|---|---|---|---|
| `capacitor-swift-pm` | 8.2.0 | MIT | ios |
| `ion-ios-filesystem` | 1.1.2 | MIT | ios |

---

## Desktop (Electron) runtime

The desktop package bundles two things: (1) the Electron runtime with its full Chromium native component set, and (2) the desktop shell's own runtime dependency closure — the five `electron-*` shell packages and their transitive dependencies (63 packages) — inside `app.asar`. Those shell-runtime packages are the ones carrying an `electron` surface in the pnpm table above. The desktop shell loads the web frontend remotely at runtime, so the `ui` production tree and the build toolchain are not bundled into the desktop package. This section covers the runtime layer.

Pinned versions of the runtime layer: **Electron 41.0.2**, **Chromium 146.0.7680.72**, **Node.js 24.14.0** (the Node build embedded in Electron 41.0.2 — distinct from the server image’s Node.js 22).

The Chromium native component set is not expanded here; the bundled `LICENSES.chromium.html` lists every component. It is a mix of licenses (BSD-3-Clause / MIT predominate, with Apache-2.0, LGPL, and MPL components as well) — it is **not** BSD/MIT with only a few MPL entries. WebKit / Blink, compiled into the main Chromium binary (not a separable module), itself contains file-level material under a mix of licenses — including BSD-family terms, the GNU Library GPL 2.0 family, and the GNU Lesser GPL 2.1 family; the exact file-level terms are recorded in the bundled `LICENSES.chromium.html`. The desktop package carries these license texts and per-component attributions via `LICENSE.electron.txt` / `LICENSES.chromium.html`; the source-acquisition note on the open-source notice page covers FFmpeg only.

| Component | Version | License | Notes |
|---|---|---|---|
| Electron runtime | 41.0.2 | MIT | Desktop runtime shell; full text in `LICENSE.electron.txt`. |
| Node.js (embedded in Electron) | 24.14.0 | MIT | Bundled inside the Electron runtime; covered by the bundled Electron license files. Distinct from the server image’s Node.js 22. |
| Chromium component set | 146.0.7680.72 (745 component entries, 736 unique names) | mixed licenses (BSD-3-Clause / MIT / Apache-2.0 / LGPL / MPL, etc.) — see `LICENSES.chromium.html` | Not enumerated here. Includes WebKit / Blink compiled into the main binary — itself a file-level mix of BSD-family terms and the GNU Library GPL 2.0 / GNU Lesser GPL 2.1 license families; see `LICENSES.chromium.html`. |
| FFmpeg | bundled with Electron 41.0.2 | LGPL-2.1-or-later | Dynamically linked, replaceable library. On Windows this is `ffmpeg.dll`; macOS and Linux ship the equivalent shared library. License in `LICENSES.chromium.html`; LGPL source-acquisition note on the open-source notice page. |
