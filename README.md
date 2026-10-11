# rsedit

A super-fast, focused text editor in the spirit of Sublime Text, built with a Rust
file engine, Tauri, and CodeMirror. No accounts, extensions, language servers,
telemetry, or background indexing.

rsedit is part of the GoodApps collection of free,
open-source desktop apps.

[Downloads](https://github.com/goodappsstore/rsedit/releases) ·
[Source](https://github.com/goodappsstore/rsedit) ·
[Issues](https://github.com/goodappsstore/rsedit/issues)

## Install

Download an installer from [GitHub Releases](https://github.com/goodappsstore/rsedit/releases)
for your operating system and processor. If no release is available yet, build
from source below.

| Platform | Architectures | Packages |
| --- | --- | --- |
| macOS | Apple silicon, Intel | DMG |
| Windows | ARM64, x64 | EXE, MSI |
| Linux | ARM64, x64 | AppImage, DEB, RPM |

On macOS, drag rsedit into Applications. On Linux, allow execution before opening
an AppImage. macOS builds are ad-hoc signed and not notarized; Windows installers
are unsigned, so your system may request approval on first launch.

The app has been built locally on macOS Apple silicon. Windows/Linux builds and
native interactions have not yet been verified; the release workflow targets
all platforms listed above.

## Features

- Intentionally limited set of features focusing on being a text editor, not IDE.
- Probably the fastest desktop text/code editor with in-built syntax highlighting. 
- Open multi-gb files in under a second or two.
- Tabs, recent files, drag-and-drop opening, and a resizable folder panel.
- Multiple cursors, rectangular selection, indentation, and comment shortcuts.
- Find/replace with regex, case and whole-word options, and match counts.
- Syntax highlighting for Rust, JavaScript, TypeScript, Python, JSON, Markdown,
  SQL, shell, and more. Language parsers load on demand.
- Command palette, quick file switching, light/dark themes, word wrap, and
  adjustable font size.
- Session restore for open tabs and unsaved buffers, plus up to 50 closed tabs.

Open files through the dialog, drag them into the window, or pass paths to the
executable. macOS Open With is supported. Use **File → Open Folder…** to browse
a folder; entries load on expansion and refresh manually.

## Keyboard shortcuts

`Mod` means `Cmd` on macOS and `Ctrl` on Windows/Linux.

| Action | Shortcut |
| --- | --- |
| New / Open / Save | Mod+N / Mod+O / Mod+S |
| Open folder | Mod+Alt+O |
| Save As | Mod+Shift+S |
| Close / Reopen tab | Mod+W / Mod+Shift+T |
| Find | Mod+F |
| Command palette | Mod+Shift+P |
| Switch file | Mod+P |
| Next / Previous tab | Ctrl+Tab / Ctrl+Shift+Tab |
| Undo / Redo | Mod+Z / Mod+Shift+Z |
| Select next occurrence | Mod+D |
| Add cursor above / below | Mod+Alt+Up / Mod+Alt+Down |
| Go to line | Mod+G |
| Toggle comment | Mod+/ |
| Toggle wrap | Mod+Shift+W |
| Font size / Reset | Mod+plus / Mod+minus / Mod+0 |

## Large files and performance

The goal is to open the first editable section of a multi-GB text file within
a second or two. Rust reads only a sample and the first section on opening, 
keeping unchanged content on disk. File reads, search, and saves run on workers.

Files larger than **4 MiB**, or containing a physical line longer than **32 KiB**,
use large-file mode. The editor loads at most **256 KiB** of original text at a
time. Use the section toolbar to move forward/backward or jump to a byte offset.

- Line numbers, go to line, selections, undo, and find/replace apply to the
  **current section**. Changing sections starts fresh section undo history.
- The first `Mod+F` opens case-sensitive literal **whole-file search**. Press it
  again for section find/replace. Whole-file regex and replace are unavailable.
- Extremely long lines use plain text. Sections may lack preceding multiline
  syntax context; folding and bracket assistance are omitted in large-file mode.
- Unedited sections are preserved byte-for-byte, including UTF-8 and CRLF
  boundaries. Memory grows with edits, loaded sections, and undo history.
- Saving streams the complete result and requires temporary disk space for it.
  Continuous scrolling through an entire large file is not supported.

Measurements on M1 Air 8GB:

| Measurement | Result |
| --- | --- |
| Warm native editor readiness, from Rust entry | 416–624 ms |
| Open and first-section read, 1 GiB Rust-core fixture | 0.22 ms |
| Peak memory, Rust-core fixture process | About 6 MiB |

Readiness includes webview initialization, excludes process-loader time, and
is not first paint. The warm-filesystem core probe excludes native UI memory
and rendering. Neither measures cold-storage or multi-GB UI opening times.
Set `RSEDIT_PROFILE_STARTUP=1` on a release executable to measure readiness.

## Sessions and file safety

Quitting preserves open tabs and unsaved buffers without prompts. Individual
unsaved tab closes still ask. Tabs restore lazily, retaining position and language
choice; undo history starts fresh after restart.

Session copies are separate from your files. Use **Save** or **Save As** to
write edits to disk. Recovery data lives in the app data directory's `session/`
folder; on macOS this is normally
`~/Library/Application Support/com.goodapps.rsedit/session/`.

Recovery happens on **orderly quit**. Force quit and crashes lose changes since
the last checkpoint. Modified large files require full recovery copies and can
make quitting slower. The window stays open if saving the session fails.

rsedit supports UTF-8 text, including a BOM and LF/CRLF. Binary and UTF-16 files
are rejected; large files are validated section by section. Edited sections
normalize mixed line endings to the detected separator.

Saves guard against external changes using size and modification time, preserve
basic permissions, and replace the destination through a synced temporary file.
These checks can miss changes that preserve metadata. There is no live watcher
or power-loss recovery guarantee. Symlinks resolve to their target; hard links,
extended metadata, and ACLs may not survive replacement.

If a large-file source changes externally, copy pending section edits before
using **Reload file from disk**. For fully loaded edited files, **Save As** can
rescue your work to a different path.

## Build from source

Install Node.js 24, current stable Rust, and the
[Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).
Use the committed lockfiles.

```sh
git clone https://github.com/goodappsstore/rsedit.git
cd rsedit
npm ci
npm run tauri dev
```

Build native installers:

```sh
npm run tauri build -- -- --locked
```

On macOS, build only the application bundle:

```sh
npm run tauri build -- --bundles app -- --locked
```

The macOS application is written to
`src-tauri/target/release/bundle/macos/rsedit.app`.
`npm run dev` provides a browser preview with a scratch buffer; filesystem access
and saving require the desktop app.

## Contributing

Report bugs or suggest focused improvements through
[GitHub Issues](https://github.com/goodappsstore/rsedit/issues). Include your OS,
app version, steps to reproduce, and any relevant error message.

For code changes, read [AGENTS.md](AGENTS.md), keep the editor small, and run:

```sh
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
node .github/scripts/check-release.mjs
```

The frontend is strict TypeScript with vanilla DOM and CodeMirror in `src/`.
Rust file handling, sessions, and native commands live in `src-tauri/src/`.

## Releases

[CI](.github/workflows/ci.yml) checks tag pushes on macOS, Windows, and Linux.
Branch pushes, pull requests, and manual dispatches do not trigger workflows.
The [release workflow](.github/workflows/release.yml) runs only on `v*` tag pushes,
builds six native targets, and publishes after verifying all twelve installers. Failures
leave a draft; published installers require a new version to replace.

Before pushing a `vMAJOR.MINOR.PATCH` tag, align the version in `package.json`,
`package-lock.json` (both root entries), `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`, and the rsedit entry in `src-tauri/Cargo.lock`.

```sh
node .github/scripts/check-release.mjs v0.1.0
```

The [release validator](.github/scripts/check-release.mjs) defines installer
names. Installers stay on GitHub Releases.
GitHub-hosted releases have not yet been verified.

## License

MIT — see [LICENSE](LICENSE).
