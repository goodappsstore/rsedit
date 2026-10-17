//! Disk-backed piece table. Unchanged bytes stay in the source file; edits own
//! only their replacement bytes. Reads and saves have bounded working buffers.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, Metadata},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};
use tempfile::NamedTempFile;

pub const SMALL_LIMIT: u64 = 64 * 1024 * 1024;
pub const PAGE_SIZE: u64 = 256 * 1024;
const IO_SIZE: u64 = 1024 * 1024;

#[derive(Clone)]
enum Source {
    Disk(Arc<File>, Stamp),
    Edit(Arc<Vec<u8>>),
}
#[derive(Clone)]
struct Piece {
    source: Source,
    start: u64,
    len: u64,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Stamp {
    size: u64,
    modified: SystemTime,
}
impl Stamp {
    fn read(path: &Path) -> Result<Self, String> {
        Self::from_metadata(&fs::metadata(path).map_err(err)?)
    }
    fn from_metadata(meta: &Metadata) -> Result<Self, String> {
        Ok(Self {
            size: meta.len(),
            modified: meta.modified().map_err(err)?,
        })
    }
}

impl Source {
    fn disk(file: File) -> Result<Self, String> {
        let stamp = Stamp::from_metadata(&file.metadata().map_err(err)?)?;
        Ok(Self::Disk(Arc::new(file), stamp))
    }
}

#[derive(Clone)]
struct EditState {
    pieces: Vec<Piece>,
    size: u64,
    version: u64,
    offset: u64,
    recovered: bool,
}

#[derive(Clone)]
pub struct Document {
    pub id: u64,
    path: Option<PathBuf>,
    stamp: Option<Stamp>,
    pieces: Vec<Piece>,
    size: u64,
    revision: u64,
    dirty: bool,
    paged: bool,
    bom: bool,
    eol: &'static str,
    recovered: bool,
    undo: Vec<EditState>,
    redo: Vec<EditState>,
    version: u64,
    saved_version: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct SavedDocument {
    path: Option<PathBuf>,
    stamp: Option<Stamp>,
    size: u64,
    dirty: bool,
    paged: bool,
    bom: bool,
    eol: String,
    pub buffer: Option<PathBuf>,
    #[serde(default)]
    pub pieces: Option<Vec<SavedPiece>>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct SavedPiece {
    buffer: PathBuf,
    start: u64,
    len: u64,
}
impl SavedDocument {
    pub fn missing_source_file(&self) -> bool {
        !self.dirty
            && self.buffer.is_none()
            && self.pieces.is_none()
            && self.path.as_ref().is_some_and(|path| {
                fs::metadata(path).is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
            })
    }
    pub fn buffers(&self) -> impl Iterator<Item = &PathBuf> {
        self.buffer
            .iter()
            .chain(self.pieces.iter().flatten().map(|piece| &piece.buffer))
    }
}
#[derive(Clone, Default)]
pub struct SnapshotSources {
    sources: std::collections::HashMap<usize, (Source, PathBuf)>,
    protected: std::collections::HashMap<usize, Source>,
}
impl SnapshotSources {
    pub fn register_recovery(&mut self, doc: &Document, saved: &SavedDocument) {
        let buffers: Vec<_> = if let Some(pieces) = &saved.pieces {
            pieces.iter().map(|piece| piece.buffer.clone()).collect()
        } else {
            saved.buffer.iter().cloned().collect()
        };
        for (piece, path) in doc.pieces.iter().zip(buffers) {
            let key = match &piece.source {
                Source::Disk(file, _) => Arc::as_ptr(file) as usize,
                Source::Edit(bytes) => Arc::as_ptr(bytes) as usize,
            };
            self.sources.insert(key, (piece.source.clone(), path));
        }
    }
    pub fn retain(&mut self, paths: &std::collections::HashSet<PathBuf>) {
        self.sources.retain(|_, (_, path)| paths.contains(path));
        self.protected
            .retain(|key, _| self.sources.contains_key(key));
    }
    /// Move live pieces and history onto completed, private recovery sources.
    /// This also covers edits made while the checkpoint was streaming.
    pub fn protect(&mut self, doc: &mut Document, directory: &Path) -> Result<(), String> {
        let mut candidate = doc.clone();
        for (pieces, recovered) in
            std::iter::once((&mut candidate.pieces, &mut candidate.recovered)).chain(
                candidate
                    .undo
                    .iter_mut()
                    .chain(&mut candidate.redo)
                    .map(|state| (&mut state.pieces, &mut state.recovered)),
            )
        {
            let mut independent = true;
            for piece in pieces {
                let Source::Disk(file, stamp) = &piece.source else {
                    continue;
                };
                let key = Arc::as_ptr(file) as usize;
                let Some((_, path)) = self.sources.get(&key).cloned() else {
                    independent = false;
                    continue;
                };
                let replacement = if let Some(source) = self.protected.get(&key) {
                    source.clone()
                } else {
                    let file = File::open(directory.join(&path)).map_err(err)?;
                    if file.metadata().map_err(err)?.len() != stamp.size {
                        return Err("A completed recovery source changed size.".into());
                    }
                    let source = Source::disk(file)?;
                    self.protected.insert(key, source.clone());
                    source
                };
                if let Source::Disk(file, _) = &replacement {
                    let replacement_key = Arc::as_ptr(file) as usize;
                    self.sources
                        .insert(replacement_key, (replacement.clone(), path));
                    self.protected.insert(replacement_key, replacement.clone());
                }
                piece.source = replacement;
            }
            *recovered |= independent;
        }
        *doc = candidate;
        Ok(())
    }
    fn copy(
        &mut self,
        source: &Source,
        directory: &Path,
        relative: &Path,
    ) -> Result<PathBuf, String> {
        let key = match source {
            Source::Disk(file, _) => Arc::as_ptr(file) as usize,
            Source::Edit(bytes) => Arc::as_ptr(bytes) as usize,
        };
        if let Some((_, path)) = self.sources.get(&key) {
            return Ok(path.clone());
        }
        let name = format!("source-{}.bin", self.sources.len());
        let mut output = File::create(directory.join(&name)).map_err(err)?;
        match source {
            Source::Disk(file, stamp) => {
                if Stamp::from_metadata(&file.metadata().map_err(err)?)? != *stamp {
                    return Err(
                        "The disk source changed before it could be copied for recovery.".into(),
                    );
                }
                let length = stamp.size;
                let mut buffer = vec![0; IO_SIZE as usize];
                let mut offset = 0;
                while offset < length {
                    let count = (length - offset).min(IO_SIZE) as usize;
                    read_exact_at(file, &mut buffer[..count], offset)?;
                    output.write_all(&buffer[..count]).map_err(err)?;
                    offset += count as u64;
                }
                if Stamp::from_metadata(&file.metadata().map_err(err)?)? != *stamp {
                    return Err(
                        "The disk source changed while it was being copied for recovery.".into(),
                    );
                }
            }
            Source::Edit(bytes) => output.write_all(bytes).map_err(err)?,
        }
        output.sync_all().map_err(err)?;
        let path = relative.join(name);
        self.sources.insert(key, (source.clone(), path.clone()));
        Ok(path)
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub id: u64,
    pub path: Option<String>,
    pub name: String,
    pub size: u64,
    pub revision: u64,
    pub dirty: bool,
    pub paged: bool,
    pub bom: bool,
    pub eol: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub text: String,
    pub start: u64,
    pub end: u64,
    pub info: Info,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchScan {
    pub count: u64,
    pub next_offset: Option<u64>,
    pub previous_offset: Option<u64>,
    pub next_index: Option<u64>,
    pub previous_index: Option<u64>,
    pub scanned_through: u64,
    pub complete: bool,
    pub revision: u64,
}
fn reject_binary(bytes: &[u8]) -> Result<(), String> {
    if bytes.contains(&0) {
        return Err(
            "This looks like a binary or UTF-16 file. rsedit currently supports UTF-8 text.".into(),
        );
    }
    Ok(())
}

fn detected_eol(bytes: &[u8]) -> &'static str {
    match memchr::memchr(b'\n', bytes) {
        Some(index) if index > 0 && bytes[index - 1] == b'\r' => "CRLF",
        Some(_) => "LF",
        None => "Unknown",
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[cfg(unix)]
fn positioned_read(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    use std::os::unix::fs::FileExt;
    file.read_at(buffer, offset)
}
#[cfg(windows)]
fn positioned_read(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    use std::os::windows::fs::FileExt;
    file.seek_read(buffer, offset)
}
fn read_exact_at(file: &File, buffer: &mut [u8], mut offset: u64) -> Result<(), String> {
    let mut remaining = buffer;
    while !remaining.is_empty() {
        let count = positioned_read(file, remaining, offset).map_err(err)?;
        if count == 0 {
            return Err(
                "The source file changed or was truncated. Reopen it before continuing.".into(),
            );
        }
        offset += count as u64;
        remaining = &mut remaining[count..];
    }
    Ok(())
}

fn validate_buffer_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || !path
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
    {
        return Err("Invalid session buffer path.".into());
    }
    Ok(())
}

impl Document {
    pub fn empty(id: u64) -> Self {
        Self {
            id,
            path: None,
            stamp: None,
            pieces: vec![],
            size: 0,
            revision: 0,
            dirty: false,
            paged: false,
            bom: false,
            eol: "LF",
            recovered: false,
            undo: vec![],
            redo: vec![],
            version: 0,
            saved_version: Some(0),
        }
    }
    pub fn open(id: u64, path: &Path) -> Result<Self, String> {
        Self::open_file(id, path, true)
    }
    pub fn from_stdin(id: u64, path: &Path) -> Result<Self, String> {
        // Only consume our private spool files, never an arbitrary user file.
        if !path
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("rsedit-stdin-"))
            || path.parent().and_then(|p| fs::canonicalize(p).ok())
                != fs::canonicalize(std::env::temp_dir()).ok()
            || !fs::symlink_metadata(path)
                .map_err(err)?
                .file_type()
                .is_file()
        {
            return Err("Invalid stdin handoff file.".into());
        }
        let cleanup = tempfile::TempPath::try_from_path(path).map_err(err)?;
        let mut input = File::open(&cleanup).map_err(err)?;
        let mut buffer = tempfile::tempfile().map_err(err)?;
        io::copy(&mut input, &mut buffer).map_err(err)?;
        drop(input);
        drop(cleanup);
        Self::from_file(id, buffer, None, true)
    }
    fn open_file(id: u64, path: &Path, validate_small: bool) -> Result<Self, String> {
        let path = fs::canonicalize(path).map_err(err)?;
        let file = File::open(&path).map_err(err)?;
        Self::from_file(id, file, Some(path), validate_small)
    }
    fn from_file(
        id: u64,
        file: File,
        path: Option<PathBuf>,
        validate_small: bool,
    ) -> Result<Self, String> {
        let metadata = file.metadata().map_err(err)?;
        if !metadata.is_file() {
            return Err("Choose a regular text file.".into());
        }
        // JS numbers must represent byte offsets exactly.
        if metadata.len() > 9_007_199_254_740_991 {
            return Err("This file exceeds the supported offset range.".into());
        }
        let mut sample = vec![0; metadata.len().min(IO_SIZE) as usize];
        read_exact_at(&file, &mut sample, 0)?;
        if sample.contains(&0)
            || sample.starts_with(&[0xff, 0xfe])
            || sample.starts_with(&[0xfe, 0xff])
        {
            return Err(
                "This looks like a binary or UTF-16 file. rsedit currently supports UTF-8 text."
                    .into(),
            );
        }
        let bom = sample.starts_with(&[0xef, 0xbb, 0xbf]);
        let start = if bom { 3 } else { 0 };
        let size = metadata.len() - start;
        let unsaved = path.is_none();
        let mut doc = Self {
            id,
            path,
            stamp: if unsaved {
                None
            } else {
                Some(Stamp::from_metadata(&metadata)?)
            },
            pieces: vec![Piece {
                source: Source::disk(file)?,
                start,
                len: size,
            }],
            size,
            revision: 0,
            dirty: unsaved,
            paged: size > SMALL_LIMIT,
            recovered: false,
            undo: vec![],
            redo: vec![],
            version: 0,
            saved_version: if unsaved { None } else { Some(0) },
            bom,
            eol: detected_eol(&sample),
        };
        if !doc.paged && validate_small {
            let bytes = doc.read_range(0, size)?;
            reject_binary(&bytes)?;
            std::str::from_utf8(&bytes)
                .map_err(|_| "This file is not valid UTF-8 text.".to_string())?;
            doc.eol = detected_eol(&bytes);
            doc.paged = bytes
                .split(|b| *b == b'\n')
                .any(|line| line.len() > 1024 * 1024);
            if !doc.paged {
                // Fully loaded buffers remain rescuable with Save As after an external edit.
                doc.pieces = vec![Piece {
                    source: Source::Edit(Arc::new(bytes)),
                    start: 0,
                    len: size,
                }];
            }
        }
        doc.check_original()?;
        Ok(doc)
    }
    pub fn info(&self) -> Info {
        Info {
            id: self.id,
            path: self.path.as_ref().map(|p| p.to_string_lossy().into_owned()),
            name: self
                .path
                .as_ref()
                .and_then(|p| p.file_name())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Untitled".into()),
            size: self.size,
            revision: self.revision,
            dirty: self.dirty,
            paged: self.paged,
            bom: self.bom,
            eol: if self.eol == "CRLF" { "CRLF" } else { "LF" },
        }
    }
    fn check_source(&self) -> Result<(), String> {
        // History can retain old open handles after Save As or atomic replacement.
        // Check each handle's own stamp, not just the current document pathname.
        let mut checked = std::collections::HashSet::new();
        for piece in &self.pieces {
            if let Source::Disk(file, stamp) = &piece.source {
                if piece.len > 0
                    && checked.insert(Arc::as_ptr(file) as usize)
                    && Stamp::from_metadata(&file.metadata().map_err(err)?)? != *stamp
                {
                    return Err("A disk source used by this buffer or undo history changed. Keep the current buffer; reload or use a completed recovery copy.".into());
                }
            }
        }
        if !self.recovered
            && self
                .pieces
                .iter()
                .any(|p| p.len > 0 && matches!(p.source, Source::Disk(..)))
        {
            self.check_original()?;
        }
        Ok(())
    }
    fn check_original(&self) -> Result<(), String> {
        if let (Some(path), Some(stamp)) = (&self.path, &self.stamp) {
            if &Stamp::read(path)? != stamp {
                return Err("This file changed on disk. Keep your buffer and use Save As, or reload from disk. Disk-backed content cannot be read safely after an external change; copy visible pending edits before reloading.".into());
            }
        }
        Ok(())
    }
    pub fn external_change(&self) -> (bool, String) {
        let (Some(path), Some(stamp)) = (&self.path, &self.stamp) else {
            return (false, String::new());
        };
        match Stamp::read(path) {
            Ok(current) => (
                current != *stamp,
                format!("{}:{:?}", current.size, current.modified),
            ),
            Err(error) => (true, error),
        }
    }
    pub fn checkpoint_key(&self) -> Result<(u64, bool), String> {
        self.check_source()?;
        Ok((self.revision, self.dirty))
    }
    /// Point an open document at a renamed path. Content, history, and revision
    /// are untouched; only the save target and external-change guard move.
    pub fn retarget(&mut self, path: PathBuf) -> Result<Info, String> {
        let path = fs::canonicalize(&path).map_err(err)?;
        if !path.is_file() {
            return Err("The renamed file is no longer available.".into());
        }
        self.stamp = Some(Stamp::read(&path)?);
        self.path = Some(path);
        Ok(self.info())
    }
    fn edit_state(&self, offset: u64) -> EditState {
        EditState {
            pieces: self.pieces.clone(),
            size: self.size,
            version: self.version,
            offset,
            recovered: self.recovered,
        }
    }
    fn remember_edit(&mut self, offset: u64) {
        if self.paged {
            self.undo.push(self.edit_state(offset));
            self.redo.clear();
        }
    }
    fn finish_edit(&mut self) {
        self.revision += 1;
        self.version = self.revision;
        self.dirty = true;
    }
    pub fn history(&mut self, redo: bool, offset: u64, revision: u64) -> Result<Page, String> {
        if revision != self.revision {
            return Err("The document changed before undo could be applied.".into());
        }
        self.check_source()?;
        let saved = if redo {
            self.redo.last()
        } else {
            self.undo.last()
        };
        if let Some(saved) = saved.cloned() {
            let mut candidate = self.clone();
            candidate.pieces = saved.pieces;
            candidate.size = saved.size;
            candidate.version = saved.version;
            candidate.recovered = saved.recovered;
            candidate.revision += 1;
            candidate.dirty = candidate.saved_version != Some(candidate.version);
            let page = candidate.page(saved.offset)?;
            let current = self.edit_state(offset);
            if redo {
                candidate.redo.pop();
                candidate.undo.push(current);
            } else {
                candidate.undo.pop();
                candidate.redo.push(current);
            }
            *self = candidate;
            return Ok(page);
        }
        self.page(offset)
    }
    fn read_range(&self, start: u64, len: u64) -> Result<Vec<u8>, String> {
        if start > self.size || len > self.size - start {
            return Err("Invalid document range.".into());
        }
        let mut output = vec![0; len as usize];
        let mut logical = 0;
        let mut written = 0;
        for piece in &self.pieces {
            let piece_end = logical + piece.len;
            if piece_end > start && logical < start + len {
                let local_start = start.saturating_sub(logical);
                let count = (piece.len - local_start).min(len - written as u64) as usize;
                let dest = &mut output[written..written + count];
                match &piece.source {
                    Source::Disk(file, _) => read_exact_at(file, dest, piece.start + local_start)?,
                    Source::Edit(bytes) => dest.copy_from_slice(
                        &bytes[(piece.start + local_start) as usize
                            ..(piece.start + local_start) as usize + count],
                    ),
                }
                written += count;
            }
            logical = piece_end;
            if written == len as usize {
                break;
            }
        }
        Ok(output)
    }
    pub fn page(&mut self, offset: u64) -> Result<Page, String> {
        self.check_source()?;
        let mut start = if self.paged { offset.min(self.size) } else { 0 };
        // A requested byte can be in the middle of a UTF-8 scalar or CRLF.
        let prefix = self.read_range(start, (self.size - start).min(4))?;
        for b in &prefix {
            if b & 0xc0 != 0x80 {
                break;
            }
            start += 1;
        }
        if start > 0 && start < self.size && self.read_range(start - 1, 2)? == b"\r\n" {
            start += 1;
        }
        let limit = if self.paged { PAGE_SIZE } else { self.size };
        let mut bytes = self.read_range(start, (self.size - start).min(limit))?;
        reject_binary(&bytes)?;
        if self.eol == "Unknown" {
            self.eol = detected_eol(&bytes);
        }
        if start + (bytes.len() as u64) < self.size {
            // Back up at most 3 bytes for the last, incomplete scalar.
            match std::str::from_utf8(&bytes) {
                Ok(_) => (),
                Err(e) if e.error_len().is_none() => bytes.truncate(e.valid_up_to()),
                Err(_) => return Err("This section is not valid UTF-8 text.".into()),
            }
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            // Prefer a complete line, without scanning/allocating an unbounded line.
            if let Some(last_newline) = bytes
                .iter()
                .enumerate()
                .rfind(|(index, byte)| {
                    **byte == b'\n'
                        && (self.eol != "CRLF" || (*index > 0 && bytes[*index - 1] == b'\r'))
                })
                .map(|(index, _)| index)
            {
                if bytes.len() - last_newline < 4096 {
                    bytes.truncate(last_newline + 1);
                }
            }
        }
        let end = start + bytes.len() as u64;
        let text = String::from_utf8(bytes)
            .map_err(|_| "This section is not valid UTF-8 text.".to_string())?;
        self.check_source()?;
        Ok(Page {
            text,
            start,
            end,
            info: self.info(),
        })
    }
    pub fn load_page(&mut self, offset: u64) -> Result<Page, String> {
        let page = self.page(offset)?;
        if !self.paged {
            self.pieces = vec![Piece {
                source: Source::Edit(Arc::new(page.text.as_bytes().to_vec())),
                start: 0,
                len: self.size,
            }];
        }
        Ok(page)
    }
    /// Resolve a whole-document, one-based location with bounded memory. Columns
    /// use UTF-16 units, matching CodeMirror; never stop inside a UTF-8 scalar.
    pub fn location_offset(&mut self, line: u64, col: u64) -> Result<u64, String> {
        if line == 0 || col == 0 {
            return Err("Line and column must be positive.".into());
        }
        self.check_source()?;
        let mut cursor = 0;
        let mut current_line = 1;
        let mut line_start = 0;
        let mut previous_cr = false;
        while cursor < self.size && current_line < line {
            let bytes = self.read_range(cursor, (self.size - cursor).min(IO_SIZE))?;
            for (index, &byte) in bytes.iter().enumerate() {
                if byte == b'\n' && self.eol == "Unknown" {
                    self.eol = if previous_cr { "CRLF" } else { "LF" };
                }
                if byte == b'\n' && (self.eol != "CRLF" || previous_cr) {
                    current_line += 1;
                    line_start = cursor + index as u64 + 1;
                    if current_line == line {
                        break;
                    }
                }
                previous_cr = byte == b'\r';
            }
            cursor += bytes.len() as u64;
        }
        cursor = line_start;
        let mut remaining = col - 1;
        while cursor < self.size && remaining > 0 {
            let mut bytes = self.read_range(cursor, (self.size - cursor).min(IO_SIZE))?;
            if cursor + (bytes.len() as u64) < self.size {
                if let Err(error) = std::str::from_utf8(&bytes) {
                    if error.error_len().is_some() {
                        return Err("This section is not valid UTF-8 text.".into());
                    }
                    bytes.truncate(error.valid_up_to());
                }
                if self.eol != "LF" && bytes.last() == Some(&b'\r') {
                    bytes.pop();
                }
            }
            let text = std::str::from_utf8(&bytes).map_err(err)?;
            if self.eol == "Unknown" {
                self.eol = detected_eol(&bytes);
            }
            let separator = if self.eol == "CRLF" { "\r\n" } else { "\n" };
            let end = text.find(separator).unwrap_or(text.len());
            for (index, character) in text[..end].char_indices() {
                let width = character.len_utf16() as u64;
                if remaining < width {
                    self.check_source()?;
                    return Ok(cursor + index as u64);
                }
                remaining -= width;
                if remaining == 0 {
                    self.check_source()?;
                    return Ok(cursor + index as u64 + character.len_utf8() as u64);
                }
            }
            cursor += end as u64;
            if end < text.len() {
                break;
            }
        }
        self.check_source()?;
        Ok(cursor)
    }
    pub fn replace(
        &mut self,
        start: u64,
        end: u64,
        text: String,
        revision: u64,
    ) -> Result<Info, String> {
        if revision != self.revision {
            return Err("The document changed before this edit could be applied.".into());
        }
        self.check_source()?;
        if start > end || end > self.size {
            return Err("Invalid edit range.".into());
        }
        for boundary in [start, end] {
            if boundary > 0
                && boundary < self.size
                && self.read_range(boundary, 1)?[0] & 0xc0 == 0x80
            {
                return Err("An edit cannot split a UTF-8 character.".into());
            }
        }
        let replacement_len = text.len() as u64;
        if self.eol == "Unknown" {
            // The view used LF while no separator was known. Keep that contract
            // when committing edits, including pasted CRLF represented literally.
            self.eol = "LF";
        }
        // Once promoted, retain backend history and bounded views across undo.
        self.paged |= self.size - (end - start) + replacement_len > SMALL_LIMIT
            || text.split('\n').any(|line| line.len() > IO_SIZE as usize);
        self.remember_edit(start);
        let mut next = Vec::new();
        let mut logical = 0;
        let added = Piece {
            source: Source::Edit(Arc::new(text.into_bytes())),
            start: 0,
            len: replacement_len,
        };
        let mut inserted = false;
        for piece in &self.pieces {
            let piece_end = logical + piece.len;
            if logical < start {
                let keep = (start - logical).min(piece.len);
                if keep > 0 {
                    next.push(Piece {
                        len: keep,
                        ..piece.clone()
                    });
                }
            }
            if !inserted && piece_end >= start {
                if replacement_len > 0 {
                    next.push(added.clone());
                }
                inserted = true;
            }
            if piece_end > end {
                let skip = end.saturating_sub(logical);
                next.push(Piece {
                    start: piece.start + skip,
                    len: piece.len - skip,
                    ..piece.clone()
                });
            }
            logical = piece_end;
        }
        if !inserted && replacement_len > 0 {
            next.push(added);
        }
        self.pieces = next;
        self.size = self.size - (end - start) + replacement_len;
        self.finish_edit();
        Ok(self.info())
    }
    pub fn mark_clean(&mut self) {
        // The fully loaded frontend retains the saved text across checkpoints.
        // It calls this only when that text equals the current document again.
        if !self.paged {
            self.dirty = false;
            self.saved_version = Some(self.version);
        }
    }
    fn write_content(&self, output: &mut File) -> Result<(), String> {
        self.check_source()?;
        if self.bom {
            output.write_all(&[0xef, 0xbb, 0xbf]).map_err(err)?;
        }
        let mut buffer = vec![0; IO_SIZE as usize];
        for piece in &self.pieces {
            match &piece.source {
                Source::Edit(bytes) => {
                    output
                        .write_all(&bytes[piece.start as usize..(piece.start + piece.len) as usize])
                        .map_err(err)?;
                }
                Source::Disk(file, _) => {
                    let mut local = 0;
                    while local < piece.len {
                        let count = (piece.len - local).min(IO_SIZE) as usize;
                        read_exact_at(file, &mut buffer[..count], piece.start + local)?;
                        output.write_all(&buffer[..count]).map_err(err)?;
                        local += count as u64;
                    }
                }
            }
        }
        output.sync_all().map_err(err)?;
        self.check_source()?;
        Ok(())
    }
    pub fn snapshot(
        &self,
        directory: &Path,
        relative_directory: &Path,
        sources: &mut SnapshotSources,
    ) -> Result<SavedDocument, String> {
        self.check_source()?;
        let pieces = if self.paged && self.dirty {
            let pieces = self
                .pieces
                .iter()
                .map(|piece| {
                    Ok(SavedPiece {
                        buffer: sources.copy(&piece.source, directory, relative_directory)?,
                        start: piece.start,
                        len: piece.len,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            self.check_source()?;
            Some(pieces)
        } else {
            None
        };
        let buffer = if pieces.is_none() && (self.dirty || self.path.is_none()) {
            let name = format!("buffer-{}.txt", self.id);
            let mut file = File::create(directory.join(&name)).map_err(err)?;
            self.write_content(&mut file)?;
            Some(relative_directory.join(name))
        } else {
            None
        };
        Ok(SavedDocument {
            path: self.path.clone(),
            stamp: self.stamp.clone(),
            size: self.size,
            dirty: self.dirty,
            paged: self.paged,
            bom: self.bom,
            eol: self.eol.into(),
            buffer,
            pieces,
        })
    }
    pub fn recover(id: u64, saved: &SavedDocument, directory: &Path) -> Result<Self, String> {
        if saved.size > 9_007_199_254_740_991 {
            return Err("Invalid session buffer size.".into());
        }
        if let Some(saved_pieces) = &saved.pieces {
            let mut pieces = Vec::new();
            let mut size = 0u64;
            let mut files = std::collections::HashMap::new();
            for piece in saved_pieces {
                validate_buffer_path(&piece.buffer)?;
                let file = match files.get(&piece.buffer) {
                    Some(file) => Arc::clone(file),
                    None => {
                        let file =
                            Arc::new(File::open(directory.join(&piece.buffer)).map_err(err)?);
                        files.insert(piece.buffer.clone(), Arc::clone(&file));
                        file
                    }
                };
                if piece
                    .start
                    .checked_add(piece.len)
                    .is_none_or(|end| end > file.metadata().map(|meta| meta.len()).unwrap_or(0))
                {
                    return Err("A recovery source is truncated or invalid.".into());
                }
                size = size
                    .checked_add(piece.len)
                    .ok_or("Invalid recovery size.")?;
                pieces.push(Piece {
                    source: Source::Disk(
                        Arc::clone(&file),
                        Stamp::from_metadata(&file.metadata().map_err(err)?)?,
                    ),
                    start: piece.start,
                    len: piece.len,
                });
            }
            if size != saved.size {
                return Err("Invalid recovery piece lengths.".into());
            }
            return Ok(Self {
                id,
                path: saved.path.clone(),
                stamp: saved.stamp.clone(),
                pieces,
                size,
                revision: 0,
                dirty: saved.dirty,
                paged: true,
                bom: saved.bom,
                eol: match saved.eol.as_str() {
                    "CRLF" => "CRLF",
                    "Unknown" => "Unknown",
                    _ => "LF",
                },
                recovered: true,
                undo: vec![],
                redo: vec![],
                version: 0,
                saved_version: if saved.dirty { None } else { Some(0) },
            });
        }
        let Some(buffer) = &saved.buffer else {
            let path = saved
                .path
                .as_ref()
                .ok_or("The session has no file or buffer.")?;
            let mut doc = Self::open_file(id, path, true)?;
            doc.paged |= saved.paged;
            return Ok(doc);
        };
        validate_buffer_path(buffer)?;
        let file = File::open(directory.join(buffer)).map_err(err)?;
        let expected = saved
            .size
            .checked_add(if saved.bom { 3 } else { 0 })
            .ok_or("Invalid buffer size.")?;
        if file.metadata().map_err(err)?.len() != expected {
            return Err("The session buffer is truncated or was changed.".into());
        }
        Ok(Self {
            id,
            path: saved.path.clone(),
            stamp: saved.stamp.clone(),
            pieces: vec![Piece {
                source: Source::disk(file)?,
                start: if saved.bom { 3 } else { 0 },
                len: saved.size,
            }],
            size: saved.size,
            revision: 0,
            dirty: saved.dirty,
            paged: saved.paged || saved.size > SMALL_LIMIT,
            bom: saved.bom,
            eol: match saved.eol.as_str() {
                "CRLF" => "CRLF",
                "Unknown" => "Unknown",
                _ => "LF",
            },
            recovered: true,
            undo: vec![],
            redo: vec![],
            version: 0,
            saved_version: if saved.dirty { None } else { Some(0) },
        })
    }
    pub fn save(&mut self, target: Option<PathBuf>) -> Result<Info, String> {
        self.check_source()?;
        let requested = target
            .or_else(|| self.path.clone())
            .ok_or("Choose a path using Save As.")?;
        let target = if requested.exists() {
            fs::canonicalize(&requested).map_err(err)?
        } else {
            let parent = requested
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            fs::canonicalize(parent)
                .map_err(err)?
                .join(requested.file_name().ok_or("Invalid filename.")?)
        };
        if self.path.as_ref() == Some(&target) {
            self.check_original()?;
        }
        let target_metadata = match fs::metadata(&target) {
            Ok(meta) => Some(meta),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(err(error)),
        };
        if target_metadata
            .as_ref()
            .is_some_and(|meta| meta.permissions().readonly())
        {
            return Err("The file is read-only. Use Save As to choose another path.".into());
        }
        let target_stamp = target_metadata
            .as_ref()
            .map(Stamp::from_metadata)
            .transpose()?;
        let parent = target.parent().ok_or("Invalid save directory.")?;
        let mut temp = NamedTempFile::new_in(parent).map_err(err)?;
        self.write_content(temp.as_file_mut())?;
        self.check_source()?;
        if self.path.as_ref() == Some(&target) {
            self.check_original()?;
        }
        let now = if target.exists() {
            let meta = fs::metadata(&target).map_err(err)?;
            if meta.permissions().readonly() {
                return Err("The file is read-only. Use Save As to choose another path.".into());
            }
            temp.as_file()
                .set_permissions(meta.permissions())
                .map_err(err)?;
            temp.as_file().sync_all().map_err(err)?;
            Some(Stamp::from_metadata(&meta)?)
        } else {
            None
        };
        if now != target_stamp {
            return Err("The destination changed while saving. Your edits are still available; retry or choose another path.".into());
        }
        // persist uses an atomic replacement on the same filesystem.
        let file = temp.persist(&target).map_err(err)?;
        self.stamp = Some(Stamp::from_metadata(&file.metadata().map_err(err)?)?);
        self.path = Some(target);
        if self.paged {
            self.pieces = vec![Piece {
                source: Source::disk(file)?,
                start: if self.bom { 3 } else { 0 },
                len: self.size,
            }];
        } else {
            let bytes = self.read_range(0, self.size)?;
            self.pieces = vec![Piece {
                source: Source::Edit(Arc::new(bytes)),
                start: 0,
                len: self.size,
            }];
        }
        self.dirty = false;
        self.saved_version = Some(self.version);
        self.revision += 1;
        self.recovered = false;
        Ok(self.info())
    }
    pub fn convert_indent(
        &mut self,
        tabs: bool,
        width: u8,
        revision: u64,
        progress: impl Fn(u64, u64),
    ) -> Result<Page, String> {
        if ![2, 4, 8].contains(&width) || revision != self.revision {
            return Err("Invalid indentation or stale revision.".into());
        }
        self.check_source()?;
        let mut output = tempfile::tempfile().map_err(err)?;
        let mut writer = io::BufWriter::with_capacity(IO_SIZE as usize, &mut output);
        let mut cursor = 0;
        let mut columns = 0u64;
        let mut leading = true;
        let mut size = 0;
        let width = width as u64;
        while cursor < self.size {
            let bytes = self.read_range(cursor, (self.size - cursor).min(IO_SIZE))?;
            let mut copied = 0;
            for (index, byte) in bytes.iter().enumerate() {
                if leading {
                    if *byte == b' ' || *byte == b'\t' {
                        columns += if *byte == b'\t' {
                            width - columns % width
                        } else {
                            1
                        };
                        copied = index + 1;
                        continue;
                    }
                    let (mut count, byte) = if tabs {
                        (columns / width, b'\t')
                    } else {
                        (columns, b' ')
                    };
                    let block = [byte; 4096];
                    while count > 0 {
                        let n = count.min(block.len() as u64) as usize;
                        writer.write_all(&block[..n]).map_err(err)?;
                        size += n as u64;
                        count -= n as u64;
                    }
                    if tabs {
                        let rest = columns % width;
                        writer.write_all(&[b' '; 8][..rest as usize]).map_err(err)?;
                        size += rest;
                    }
                    columns = 0;
                    leading = false;
                }
                if *byte == b'\n' {
                    writer.write_all(&bytes[copied..=index]).map_err(err)?;
                    size += (index + 1 - copied) as u64;
                    copied = index + 1;
                    leading = true;
                }
            }
            writer.write_all(&bytes[copied..]).map_err(err)?;
            size += (bytes.len() - copied) as u64;
            cursor += bytes.len() as u64;
            if cursor % (16 * IO_SIZE) == 0 || cursor == self.size {
                progress(cursor, self.size);
            }
        }
        // Preserve a final whitespace-only line without buffering its length.
        let (mut count, byte) = if tabs {
            (columns / width, b'\t')
        } else {
            (columns, b' ')
        };
        let block = [byte; 4096];
        while count > 0 {
            let n = count.min(4096) as usize;
            writer.write_all(&block[..n]).map_err(err)?;
            size += n as u64;
            count -= n as u64;
        }
        if tabs {
            let rest = columns % width;
            writer.write_all(&[b' '; 8][..rest as usize]).map_err(err)?;
            size += rest;
        }
        writer.flush().map_err(err)?;
        drop(writer);
        output.sync_all().map_err(err)?;
        self.check_source()?;
        self.paged |= size > SMALL_LIMIT;
        self.remember_edit(0);
        self.pieces = vec![Piece {
            source: Source::disk(output)?,
            start: 0,
            len: size,
        }];
        self.size = size;
        self.recovered = true;
        self.finish_edit();
        self.page(0)
    }
    pub fn replace_all(
        &mut self,
        query: &str,
        replacement: &str,
        revision: u64,
        progress: impl Fn(u64, u64),
    ) -> Result<(Page, u64), String> {
        if revision != self.revision {
            return Err("The document changed before replacement could start.".into());
        }
        if query.is_empty() || query.len() > 4096 {
            return Err("Enter between 1 and 4096 bytes to replace.".into());
        }
        self.check_source()?;
        let mut output = tempfile::tempfile().map_err(err)?;
        let mut writer = io::BufWriter::with_capacity(IO_SIZE as usize, &mut output);
        let finder = memchr::memmem::Finder::new(query.as_bytes());
        let mut cursor = 0;
        let mut count = 0;
        let mut size = 0;
        let mut last_progress = 0;
        while cursor < self.size {
            let bytes = self.read_range(
                cursor,
                (self.size - cursor).min(IO_SIZE + query.len() as u64),
            )?;
            let covered = IO_SIZE.min(self.size - cursor) as usize;
            let mut local = 0;
            while let Some(found) = finder.find(&bytes[local..]) {
                let position = local + found;
                if position >= covered {
                    break;
                }
                writer.write_all(&bytes[local..position]).map_err(err)?;
                writer.write_all(replacement.as_bytes()).map_err(err)?;
                size += (position - local + replacement.len()) as u64;
                count += 1;
                local = position + query.len();
            }
            let consumed = covered.max(local);
            if local < consumed {
                writer.write_all(&bytes[local..consumed]).map_err(err)?;
                size += (consumed - local) as u64;
            }
            cursor += consumed as u64;
            if cursor - last_progress >= 16 * IO_SIZE || cursor == self.size {
                progress(cursor, self.size);
                last_progress = cursor;
            }
        }
        writer.flush().map_err(err)?;
        drop(writer);
        output.sync_all().map_err(err)?;
        self.check_source()?;
        if count > 0 {
            self.paged |= size > SMALL_LIMIT;
            self.remember_edit(0);
            self.pieces = vec![Piece {
                source: Source::disk(output)?,
                start: 0,
                len: size,
            }];
            self.size = size;
            self.recovered = true;
            self.finish_edit();
        }
        Ok((self.page(0)?, count))
    }
    // Count and locate adjacent matches without retaining an unbounded result list.
    pub fn scan_search(&self, query: &str, start: u64, anchor: u64) -> Result<SearchScan, String> {
        self.check_source()?;
        if query.is_empty() || query.len() > 4096 {
            return Err("Enter between 1 and 4096 bytes to search.".into());
        }
        let mut cursor = start.min(self.size);
        let scan_end = self.size.min(cursor.saturating_add(64 * 1024 * 1024));
        let finder = memchr::memmem::Finder::new(query.as_bytes());
        let mut result = SearchScan {
            count: 0,
            next_offset: None,
            previous_offset: None,
            next_index: None,
            previous_index: None,
            scanned_through: scan_end,
            complete: scan_end >= self.size,
            revision: self.revision,
        };
        while cursor < scan_end {
            let bytes = self.read_range(
                cursor,
                (self.size - cursor).min(IO_SIZE + query.len() as u64),
            )?;
            let covered = IO_SIZE.min(scan_end - cursor);
            let mut local = 0;
            while let Some(found) = finder.find(&bytes[local..]) {
                let position = local + found;
                if position as u64 >= covered {
                    break;
                }
                let offset = cursor + position as u64;
                if offset >= anchor && result.next_offset.is_none() {
                    result.next_offset = Some(offset);
                    result.next_index = Some(result.count);
                }
                if offset < anchor {
                    result.previous_offset = Some(offset);
                    result.previous_index = Some(result.count);
                }
                result.count += 1;
                local = position + query.len();
            }
            cursor += covered.max(local as u64);
        }
        self.check_source()?;
        Ok(result)
    }
}
