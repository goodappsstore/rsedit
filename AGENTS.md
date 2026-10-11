# rsedit

Read README.md before changing product behavior or build commands. Parent agent
instructions apply. Keep this a small text editor: no IDE services, background
indexing, startup network calls, or unrelated features.

- The reference bootstrap is ../sessions-box. This app uses strict TypeScript,
  vanilla DOM + CodeMirror, Vite, Rust 2021, and Tauri v2.
- Frontend/native payloads must agree across src/api.ts, src/main.ts, and command
  registration in src-tauri/src/lib.rs. Preserve camelCase response fields.
- Filesystem reads/search/save run on blocking workers, with locks per document.
  Keep the registry lock brief and never do disk I/O while holding it.
- Preserve bounded large-file reads, UTF-8/CRLF boundaries, revision checks,
  external-change guards, permission preservation, and temporary-file replacement.
  Unchanged source bytes must survive section edits byte-for-byte.
- Large-file sections are an explicit product tradeoff. Do not silently pretend
  section line numbers, undo, or find/replace operate on the entire file.
- Preserve hot exit: checkpoint open and closed buffers before destroying the
  window; quit never asks unsaved-change questions, while individual tab closes
  still prompt. Keep closed history capped at 50 and serialize close/reopen actions.
- Session copies belong to Tauri app_data_dir()/session; they do not replace user
  files. Never overwrite an unreadable prior manifest or remove failed recovery
  buffers. Stream large snapshots and load restored tabs lazily.
- Keep language parsers lazy and the startup path free of file indexing. Measure
  release startup and memory; distinguish Rust-core timings from native UI timings.
- Use npm ci and committed lockfiles. Normal checks: npm run check; cargo fmt
  --manifest-path src-tauri/Cargo.toml -- --check; cargo clippy --locked
  --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings.
- No committed test suite exists. Follow parent guidance: do not add one unless
  asked. Use isolated disposable fixtures for file-operation probes. Do not take
  screenshots unless asked. Never verify saving against personal files.
- Update README.md for visible behavior, commands, limitations, and verification.
  Report platform and runtime coverage accurately; local macOS builds do not
  establish Windows/Linux verification.
