# rsedit

A super-fast, focused text editor in the spirit of Sublime Text, built with a Rust
file engine, Tauri, and CodeMirror. No accounts, extensions, language servers,
telemetry, or background indexing.

rsedit is part of the GoodApps collection of free,
open-source desktop apps.

[Downloads](https://github.com/goodappsstore/rsedit/releases) ·
[Source](https://github.com/goodappsstore/rsedit) ·
[Issues](https://github.com/goodappsstore/rsedit/issues)

## Screenshots

### rsedit homescreen

![rsedit homescreen](screenshots/homepage.jpg)

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
- Fast text/code editing with lazy syntax highlighting.
- Bounded multi-GB opening; a 3 GiB release UI probe opened within two seconds
  on the measured Mac (see the performance limits below).
- Tabs, recent files, drag-and-drop opening, and a resizable folder panel.
- Split editor panes side by side, with a draggable divider and session restore.
- Multiple cursors, rectangular selection, indentation, and comment shortcuts.
- Full-width bottom find/replace panel with regex, case and whole-word options,
  and match counts.
- Syntax highlighting for Rust, JavaScript, TypeScript, Python, JSON, Markdown,
  SQL, shell, and more. Language parsers load on demand.
- Command palette, fuzzy quick-open within the selected folder, ten themes
  (Rsedit Dark/Light, Monokai, Dracula, Nord, Solarized Dark/Light, One Dark,
  Gruvbox Dark, Tokyo Night), word wrap (enabled by default), and adjustable font size.
- Per-file indentation detection, literal tabs or 2/4/8 spaces, and explicit
  whole-file indentation conversion.
- Focus-time checks for external file changes, with clean-buffer reload and
  recovery choices for edited buffers.
- Periodic crash recovery and session restore for open tabs and unsaved buffers,
  plus up to 50 closed tabs.

Open files through the dialog, drag them into the window, or pass paths to the
executable. CLI launches reuse and focus the running window. macOS Open With is supported. Use **File → Open Folder…** to browse
a folder; entries load on expansion and refresh manually. Each listing examines
at most 2,000 entries and reports when that limit is reached. Names that cannot
be represented as UTF-8 are omitted with a notice; manage them in the system file
manager. **Mod+P** fuzzy-matches
open tabs and relative paths beneath that folder. Folder search runs only when
requested, with no persistent index. Each request returns at most 80 results
and stops after 50,000 entries or one second; the palette reports partial results
and unreadable directories. It skips `.git`, `node_modules`, `target`, and directory
symlinks. Without a selected folder, quick-open searches open tabs.

Right-click (or `Shift+F10` on a focused row) a folder entry to create files
and folders, rename, permanently delete with confirmation, copy the path, or
reveal it in the system file manager. Open buffers track renames; deleting a
file closes its clean tabs but keeps edited buffers, which offer Save As to
survive.
Creating or renaming an entry never replaces an existing destination. Renames
fail if the filesystem cannot enforce this.

**Mod+\\** (or View → Split Editor Right) shows a second file beside the
current one. Click either side to focus it; menu actions, search panels, page
navigation, and status bar follow focus. The tab strip is shared: clicking a
tab shows it in the focused pane, and closing a pane never closes its file.
The split restores with the session; the divider width is remembered.
The editor receives keyboard focus after startup restores the session and opens
any launch files, so you can start typing immediately.

The window remembers its last size, position, and maximized or full-screen mode
across launches. Word wrap remembers your preference; toggle it from
**View → Word Wrap** or **Mod+Shift+W**. The native menu uses the system menu bar
on macOS and the window menu bar on Windows/Linux. File tabs sit directly above
the editor in a rounded, browser-style strip, with a **+** button for new files
and close buttons on active or hovered tabs. Middle-click a tab to close it.
The command palette is available from
**View → Command Palette** or **Mod+Shift+P**.

Adjust the editor font with **Mod++** (or **Mod+=**) and **Mod+-**; **Mod+0**
resets it to 14 px. These shortcuts work throughout the window, including search
and the command palette. **View → Increase Font Size / Decrease Font Size /
Reset Font Size** provides the same controls. Font size is saved between launches
and applies to both editor panes, within a range of 10–28 px.

Click the indentation indicator to choose spaces or literal tabs for the current
file, or to convert its leading indentation. Detection samples the first 64 KiB;
ambiguous or mixed indentation may need an explicit choice. Changing the setting
affects future input; conversion is a separate undoable command and preserves
alignment using the selected tab width. The setting is retained in the session.

## Command line

With the rsedit executable on your `PATH`:

```sh
rsedit notes.txt                 # Open a file
rsedit new-file.md               # Start a named file if it does not exist
rsedit src/main.ts:42            # Go to line 42
rsedit src/main.ts:42:8          # Go to line 42, column 8
rsedit .                        # Browse the current directory
rsedit ./project notes.txt:10:2  # Open a folder and a file
printf 'Hello\n' | rsedit -      # Open stdin as an unsaved buffer
rsedit - < output.txt           # Redirected stdin
```

Paths resolve from the invoking shell's working directory, including when a
window is already open. A missing file opens as an empty, unsaved buffer with
the requested filename in its tab and syntax highlighting based on its extension.
Its parent directory must exist. **Save** creates the file at that path; opening
it alone does not create a file on disk. Repeated launches focus the same open
buffer. Named new buffers participate in session recovery. If another process
creates the file before the first save, rsedit keeps your buffer and asks you to
use Save As rather than overwrite that file.

Quote paths containing spaces. Lines and columns are
one-based; columns use UTF-16 units as in the editor, and out-of-range positions
clamp to the last line or the end of that line. An existing filename containing
colons takes precedence over location syntax. Locations in huge files scan to
the requested line on a worker with bounded memory, then show the relevant view;
the view's displayed line numbers remain relative to that view.

`-` reads UTF-8 stdin until EOF into a temporary disk buffer before opening it.
The resulting untitled tab participates in session recovery and uses Save As;
the redirected source is never overwritten. Repeated `-` arguments open that
input once. For a file literally named `-`, use `./-`. Invalid paths and unsupported
text are reported in the editor. Use `--` before paths beginning with a dash;
`-- -` opens a literal file named `-`.

When no instance is running, a CLI launch stays in the foreground until the
editor quits, including when opening stdin. Launches that reuse a running
instance return after handing off their requests.

## Keyboard shortcuts

`Mod` means `Cmd` on macOS and `Ctrl` on Windows/Linux.

Application shortcuts use one handler across the editor, search fields, folder
panel, and command palette. Menu commands use the same actions. Undo and redo in
a text field edit that field; in the editor they use the document's history.

| Action | Shortcut |
| --- | --- |
| New / Open / Save | Mod+N / Mod+O / Mod+S |
| Open folder | Mod+Alt+O |
| Save As | Mod+Shift+S |
| Close / Reopen tab | Mod+W / Mod+Shift+T |
| Find | Mod+F |
| Close search and keep current match | Escape |
| Command palette | Mod+Shift+P |
| Quick-open folder files / open tabs | Mod+P |
| Split editor right / close split | Mod+\ |
| Previous / Next tab | Mod+Shift+[ / Mod+Shift+] |
| Next / Previous tab (alternate) | Ctrl+Tab / Ctrl+Shift+Tab |
| Undo / Redo | Mod+Z / Mod+Shift+Z |
| Redo (alternate) | Ctrl+Y on Windows/Linux |
| Select next occurrence | Mod+D |
| Select all occurrences (visible view for huge files) | Mod+Shift+L |
| Duplicate line up / down | Alt+Shift+Up / Alt+Shift+Down |
| Move line up / down | Alt+Up / Alt+Down |
| Delete line | Mod+Shift+K |
| Find/replace in visible view only (huge files) | Cmd+Option+F (macOS), Ctrl+H (Windows/Linux) |
| Add cursor above / below | Mod+Alt+Up / Mod+Alt+Down |
| Go to line | Mod+G |
| Toggle comment | Mod+/ |
| Toggle wrap | Mod+Shift+W |
| Increase / Decrease font size | Mod++ (or Mod+=) / Mod+- |
| Reset font size | Mod+0 |
| Quit | Mod+Q |

## Large files and performance

Opening a multi-GB file reads only a sample and its first **256 KiB** view.
Unchanged content remains on disk, and reads, search, saves, and recovery copies
run on workers. Opening does not scan the whole file or create a recovery copy.

Files up to **64 MiB** normally use the full editor: continuous scrolling,
whole-document regex find/replace, selections, and CodeMirror undo. A physical
line longer than **1 MiB** also selects bounded views. Files above 4 MiB start with
plain text to avoid automatic parser work; a language can still be selected
explicitly.

For huge files, bounded views are for navigation; edits belong to one disk-backed
document. Saving always streams the **entire resulting file**, with unchanged
bytes retained exactly. The toolbar moves between views or jumps to a byte offset.

- **Mod+F** always opens case-sensitive literal **whole-file find/replace**.
  Replace all streams into a temporary disk buffer, shows progress, and commits
  only after the operation succeeds and source guards pass. Your user file changes
  only when you Save. Replacement and indentation conversion are undoable.
- **Undo/redo span views and saves**. Pending view edits become a history group
  when flushed for navigation, recovery, save, whole-file operations, or undo.
  Ordinary files retain CodeMirror's typing history. Restart starts fresh history.
- Line numbers, go to line, selections, and multiple cursors remain relative to
  the **visible view**. **Cmd+Option+F** on macOS or **Ctrl+H** on Windows/Linux
  explicitly opens view-only regex find/replace;
  its scope is displayed, including the scope of Replace all. Whole-file regex
  replacement and continuous scrolling across huge-file views are not supported.
- Extremely long lines use plain text. Views may lack preceding multiline syntax
  context; folding and bracket assistance are omitted in bounded mode.
- Unchanged text survives local edits byte-for-byte, including BOM, UTF-8, CRLF,
  and mixed separators outside changed ranges. Memory grows with edits, loaded
  views, and undo history. Whole-file operations require temporary disk space.
- Long operations display status/progress and lock the affected document while
  allowing tab switching. A background recovery copy captures immutable pieces
  with a brief document lock; its disk streaming does not lock out typing.

Release measurements on an M1 Air with 8 GiB RAM, macOS arm64, using disposable
3 GiB text fixtures on the local filesystem:

| Measurement | Result |
| --- | --- |
| First 3 GiB native view readiness, from Rust entry | 1.34 s |
| 3 GiB native open request to view readiness | 132 ms |
| 3 GiB Rust-core open and first-view read | 0.46–1.23 ms |
| Peak RSS, separate Rust-core open-only process | 2.3 MiB |
| Sampled native app RSS at initial view | About 98 MiB |
| Sampled newly spawned WebKit processes, combined RSS | About 95 MiB |
| First full recovery source copy for an edited 3 GiB file | 3.52–5.53 s |
| Subsequent checkpoint after another one-byte edit | 9.4–13.2 ms |
| Unchanged / edited checkpoint after recovery restart | 5.3–9.9 / 9.1–9.5 ms |
| Recovered 3 GiB Save As | 4.50–4.75 s |

Native readiness includes webview initialization and two animation-frame callbacks
after installing the first view; it excludes process-loader time and is not a
first-paint instrument. Native RSS is a point-in-time sample, not a peak, and the
WebKit total covers newly spawned content/GPU/networking processes. Core timings
exclude the native UI. Fixtures were freshly written or warm; cold storage,
remote filesystems, and Windows/Linux UI performance are not established. The
under-two-second target is demonstrated on this setup, not a guarantee for every
machine or storage device. Set `RSEDIT_PROFILE_STARTUP=1` on a release executable
to log editor and newly opened view readiness.

## Sessions and file safety

Quitting preserves open tabs and unsaved buffers without prompts. Individual
unsaved tab closes still ask. Tabs retain position and language choice; ordinary
small files restore into memory, while huge files keep bounded disk-backed views.
Undo history starts fresh after restart.
Clean tabs whose source files have moved or been deleted are silently skipped
and removed from the saved session. Restoring a saved view yields to new clicks,
edits, or scrolling, and automatic disk reloads preserve the cursor and viewport
where the updated content allows.

Session copies are separate from your files. Use **Save** or **Save As** to
write edits to disk. Recovery data lives in the app data directory's `session/`
folder; on macOS this is normally
`~/Library/Application Support/com.goodapps.rsedit/session/`.

Recovery is checkpointed **every 30 seconds** after startup, as well as on orderly
quit. A busy file can defer a periodic checkpoint; the next interval retries.
The status bar shows checkpoint progress, success, failure, and newer edits still
awaiting recovery. Crashes and force
quit restore the last completed checkpoint; newer edits can still be lost.

For edited huge files, the first checkpoint streams an immutable copy of each
source into the session directory. Later checkpoints reuse those copies and
store changed bytes plus piece references, including after recovery restart.
After a successful checkpoint, live disk-backed pieces and matching undo/redo
history read from the completed private recovery copies, so later external
overwrites cannot invalidate those bytes.
Unchanged buffers reuse their last snapshot. The manifest is replaced only after
all new recovery data is synced; an interrupted checkpoint leaves the previous
manifest usable. A corrupt, unreadable, or unsupported manifest and its buffer
generations are moved to a `preserved-*` subdirectory before starting a fresh
session. Interrupted archives finish on the next launch. Manifests are limited to
16 MiB. Individual failed recovery buffers retain their existing references.
If a tab cannot be checkpointed and has a previous snapshot, that snapshot is
retained while other tabs are checkpointed. Without a previous
snapshot, the existing manifest is preserved. Errors identify affected
files and warn that newer edits are not saved. If the final checkpoint fails,
the app offers Keep editing or an explicit Quit without recovery choice.
Recovery copies can take seconds and require disk space, especially after a
whole-file operation.

rsedit supports UTF-8 text, including a BOM and LF/CRLF. Opening checks the first
1 MiB for NUL bytes and UTF-16 BOMs. Fully loaded files and every huge-file view
reject NUL bytes and invalid UTF-8; unseen bytes in huge files are checked when
viewed. New editor line breaks use the detected separator; unchanged source
bytes keep their original separators. The first observed newline determines LF
or CRLF; edits use LF if none has been observed. With CRLF selected, lone LF bytes
remain literal content in that line across navigation and editing.

Saves guard against external changes using size and modification time, preserve
basic permissions, and replace the destination through a synced temporary file.
Retained disk handles also carry their own metadata guards, so undo cannot
silently read changed old source bytes after Save As. These checks can miss changes
that preserve metadata. On regaining focus, rsedit checks open files, reloads clean buffers, and offers edited buffers choices
to keep edits, Save As, copy the visible text to a new recovery tab, or reload
with a discard prompt. Repeated notices for the same disk version are suppressed.
There is no live watcher or power-loss recovery guarantee. Opening and saving
symlinks resolve to their target; folder rename/delete actions operate on the
link itself. Hard links, extended metadata, and ACLs may not survive replacement.

If an original disk-backed huge-file source changes externally before its first
successful recovery copy, rsedit cannot safely reconstruct unseen old bytes. Use **Copy visible text to a new recovery
tab** before reloading, and retain the last successful checkpoint. Fully loaded,
restored, or completely transformed buffers can be rescued with **Save As** to
another path. rsedit never silently overwrites an external change.

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

For code changes, keep the editor small and run:

```sh
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
node .github/scripts/check-release.mjs
```

The frontend is strict TypeScript with vanilla DOM and CodeMirror in `src/`.
Rust file handling, sessions, and native commands live in `src-tauri/src/`.

Verification for these changes used disposable Rust fixtures for byte preservation,
BOM/UTF-8/CRLF boundaries, permission preservation, external-save guards, stale
revisions, cross-view/cross-save undo, streamed replacement and indentation,
3 GiB recovery copies, restart snapshot reuse, unreadable manifests, and folder
quick-open. Disposable DOM probes covered per-file indentation, conversion/undo,
fuzzy tab filtering, and palette discoverability. Mocked desktop IPC probes
covered typing during recovery streaming, checkpoint/close/reopen ordering,
focus-time clean reload and edited-buffer recovery choices, and quit preserving
open/closed buffers without unsaved prompts. The macOS release app was
launched with an isolated application identifier and a disposable 3 GiB file;
opening/readiness and memory were measured without screenshots. Native dialogs,
focus interactions, and Windows/Linux runtime behavior remain unverified.

## Releases

The [release workflow](.github/workflows/release.yml) is the only workflow and
runs on `v*` tag pushes. It checks frontend and Rust builds, formatting, and
Clippy on all six native targets, builds installers, and publishes after verifying
all twelve installers. Branch pushes, pull requests, and manual dispatches do not
trigger workflows. Failures leave a draft; published installers require a new
version to replace.

To prepare a release, commit your current work, then run:

```sh
node .github/scripts/prepare-release.mjs v0.1.5
```

The script requires a clean working tree and a new `vMAJOR.MINOR.PATCH` tag.
It aligns the version in `package.json`,
`package-lock.json` (both root entries), `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`, and the rsedit entry in `src-tauri/Cargo.lock`, runs the
release validator, creates a `Release vMAJOR.MINOR.PATCH` commit, and creates an
annotated local tag on that commit. It does **not** push anything. If a Git
commit or tag command fails, inspect the local changes before retrying.

To validate release metadata separately:

```sh
node .github/scripts/check-release.mjs v0.1.0
```

The [release validator](.github/scripts/check-release.mjs) defines installer
names. Installers stay on GitHub Releases.
GitHub-hosted releases have not yet been verified.

## License

MIT — see [LICENSE](LICENSE).
