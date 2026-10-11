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

pub const SMALL_LIMIT: u64 = 4 * 1024 * 1024;
pub const PAGE_SIZE: u64 = 256 * 1024;
const IO_SIZE: u64 = 1024 * 1024;

#[derive(Clone)]
enum Source {
    Disk(Arc<File>),
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
pub struct SearchResult {
    pub offsets: Vec<u64>,
    pub scanned_through: u64,
    pub complete: bool,
    pub revision: u64,
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
        }
    }
    pub fn open(id: u64, path: &Path) -> Result<Self, String> {
        Self::open_file(id, path, true)
    }
    fn open_file(id: u64, path: &Path, validate_small: bool) -> Result<Self, String> {
        let path = fs::canonicalize(path).map_err(err)?;
        let file = File::open(&path).map_err(err)?;
        let metadata = file.metadata().map_err(err)?;
        if !metadata.is_file() {
            return Err("Choose a regular text file.".into());
        }
        // JS numbers must represent byte offsets exactly.
        if metadata.len() > 9_007_199_254_740_991 {
            return Err("This file exceeds the supported offset range.".into());
        }
        let mut sample = vec![0; metadata.len().min(8192) as usize];
        read_exact_at(&file, &mut sample, 0)?;
        if sample.contains(&0) {
            return Err(
                "This looks like a binary or UTF-16 file. rsedit currently supports UTF-8 text."
                    .into(),
            );
        }
        let bom = sample.starts_with(&[0xef, 0xbb, 0xbf]);
        let start = if bom { 3 } else { 0 };
        let size = metadata.len() - start;
        let mut doc = Self {
            id,
            path: Some(path),
            stamp: Some(Stamp::from_metadata(&metadata)?),
            pieces: vec![Piece {
                source: Source::Disk(Arc::new(file)),
                start,
                len: size,
            }],
            size,
            revision: 0,
            dirty: false,
            paged: size > SMALL_LIMIT,
            recovered: false,
            bom,
            eol: if sample.windows(2).any(|b| b == b"\r\n") {
                "CRLF"
            } else {
                "LF"
            },
        };
        if !doc.paged && validate_small {
            let bytes = doc.read_range(0, size)?;
            std::str::from_utf8(&bytes)
                .map_err(|_| "This file is not valid UTF-8 text.".to_string())?;
            doc.paged = bytes
                .split(|b| *b == b'\n')
                .any(|line| line.len() > 32 * 1024);
        }
        doc.check_source()?;
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
            eol: self.eol,
        }
    }
    fn check_source(&self) -> Result<(), String> {
        if !self.recovered
            && self
                .pieces
                .iter()
                .any(|p| p.len > 0 && matches!(p.source, Source::Disk(_)))
        {
            self.check_original()?;
        }
        Ok(())
    }
    fn check_original(&self) -> Result<(), String> {
        if let (Some(path), Some(stamp)) = (&self.path, &self.stamp) {
            if &Stamp::read(path)? != stamp {
                return Err("This file changed on disk. For a fully loaded file, use Save As to keep your edits. A disk-backed large file must be reopened; copy any pending section edits first.".into());
            }
        }
        Ok(())
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
                    Source::Disk(file) => read_exact_at(file, dest, piece.start + local_start)?,
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
    pub fn page(&self, offset: u64) -> Result<Page, String> {
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
        let limit = if self.paged { PAGE_SIZE } else { SMALL_LIMIT };
        let mut bytes = self.read_range(start, (self.size - start).min(limit))?;
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
            if let Some(last_newline) = memchr::memrchr(b'\n', &bytes) {
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
        self.revision += 1;
        self.dirty = true;
        Ok(self.info())
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
                Source::Disk(file) => {
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
    ) -> Result<SavedDocument, String> {
        let buffer = if self.dirty || self.path.is_none() {
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
        })
    }
    pub fn recover(id: u64, saved: &SavedDocument, directory: &Path) -> Result<Self, String> {
        if saved.size > 9_007_199_254_740_991 {
            return Err("Invalid session buffer size.".into());
        }
        let Some(buffer) = &saved.buffer else {
            let path = saved
                .path
                .as_ref()
                .ok_or("The session has no file or buffer.")?;
            let mut doc = Self::open_file(id, path, false)?;
            doc.paged |= saved.paged;
            return Ok(doc);
        };
        if buffer.is_absolute()
            || !buffer
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_)))
        {
            return Err("Invalid session buffer path.".into());
        }
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
                source: Source::Disk(Arc::new(file)),
                start: if saved.bom { 3 } else { 0 },
                len: saved.size,
            }],
            size: saved.size,
            revision: 0,
            dirty: saved.dirty,
            paged: saved.paged || saved.size > SMALL_LIMIT,
            bom: saved.bom,
            eol: if saved.eol == "CRLF" { "CRLF" } else { "LF" },
            recovered: true,
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
        let target_stamp = if target.exists() {
            Some(Stamp::read(&target)?)
        } else {
            None
        };
        let parent = target.parent().ok_or("Invalid save directory.")?;
        let mut temp = NamedTempFile::new_in(parent).map_err(err)?;
        self.write_content(temp.as_file_mut())?;
        if let Ok(meta) = fs::metadata(&target) {
            if meta.permissions().readonly() {
                return Err("The file is read-only. Use Save As to choose another path.".into());
            }
            temp.as_file()
                .set_permissions(meta.permissions())
                .map_err(err)?;
        }
        temp.as_file().sync_all().map_err(err)?;
        self.check_source()?;
        if self.path.as_ref() == Some(&target) {
            self.check_original()?;
        }
        let now = if target.exists() {
            Some(Stamp::read(&target)?)
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
        self.pieces = vec![Piece {
            source: Source::Disk(Arc::new(file)),
            start: if self.bom { 3 } else { 0 },
            len: self.size,
        }];
        self.dirty = false;
        self.recovered = false;
        Ok(self.info())
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
            cursor += covered;
        }
        self.check_source()?;
        Ok(result)
    }
    pub fn search(&self, query: &str, start: u64) -> Result<SearchResult, String> {
        self.check_source()?;
        if query.is_empty() || query.len() > 4096 {
            return Err("Enter between 1 and 4096 bytes to search.".into());
        }
        let mut offsets = Vec::new();
        let mut cursor = start.min(self.size);
        let finder = memchr::memmem::Finder::new(query.as_bytes());
        // Bounded requests allow navigation/cancellation between scan batches.
        let scan_end = self.size.min(cursor.saturating_add(64 * 1024 * 1024));
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
                offsets.push(cursor + position as u64);
                local = position + query.len();
                if offsets.len() == 200 {
                    let through = cursor + local as u64;
                    self.check_source()?;
                    return Ok(SearchResult {
                        offsets,
                        scanned_through: through,
                        complete: through >= self.size,
                        revision: self.revision,
                    });
                }
            }
            cursor += covered;
        }
        self.check_source()?;
        Ok(SearchResult {
            offsets,
            scanned_through: cursor,
            complete: cursor >= self.size,
            revision: self.revision,
        })
    }
}
