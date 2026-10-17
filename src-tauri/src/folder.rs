use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    name: String,
    path: String,
    is_directory: bool,
    is_symlink: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    name: String,
    path: String,
    entries: Vec<FolderEntry>,
    truncated: bool,
    unsupported_names: bool,
}

pub fn read_directory(path: PathBuf) -> Result<FolderListing, String> {
    let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
    let display_path = path_string(&path)?;
    let mut entries = Vec::new();
    let mut truncated = false;
    let mut unsupported_names = false;
    for (visited, entry) in fs::read_dir(&path).map_err(|e| e.to_string())?.enumerate() {
        if visited >= 2000 {
            truncated = true;
            break;
        }
        let entry = entry.map_err(|e| e.to_string())?;
        // IPC paths are UTF-8. Never expose a lossy path that could name a
        // different file (for example a literal Unicode replacement character).
        if entry.file_name().to_str().is_none() {
            unsupported_names = true;
            continue;
        }
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        // Follow symlinks, but omit broken links and special files such as pipes.
        let (is_directory, is_file) = if kind.is_symlink() {
            match fs::metadata(entry.path()) {
                Ok(metadata) => (metadata.is_dir(), metadata.is_file()),
                Err(_) => continue,
            }
        } else {
            (kind.is_dir(), kind.is_file())
        };
        if is_directory || is_file {
            entries.push(FolderEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: entry.path().to_string_lossy().into_owned(),
                is_directory,
                is_symlink: kind.is_symlink(),
            });
        }
    }
    entries.sort_by_cached_key(|entry| (!entry.is_directory, entry.name.to_lowercase()));
    Ok(FolderListing {
        name: path
            .file_name()
            .unwrap_or(path.as_os_str())
            .to_string_lossy()
            .into_owned(),
        path: display_path,
        entries,
        truncated,
        unsupported_names,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickOpen {
    entries: Vec<FolderEntry>,
    truncated: bool,
    skipped_directories: u64,
}

fn fuzzy_score(path: &str, query: &str) -> Option<i64> {
    let path = path.to_lowercase().replace('\\', "/");
    let mut wanted = query.chars().peekable();
    let mut score = 0;
    let mut run = 0;
    let mut boundary = true;
    for (index, ch) in path.chars().enumerate() {
        if wanted.peek() == Some(&ch) {
            wanted.next();
            run += 1;
            score += 20 + run * 8 + if boundary { 30 } else { 0 } - index as i64;
        } else {
            run = 0;
        }
        boundary = matches!(ch, '/' | '\\' | '_' | '-' | '.' | ' ');
        if wanted.peek().is_none() {
            return Some(score - path.len() as i64);
        }
    }
    if wanted.peek().is_none() {
        Some(-(path.len() as i64))
    } else {
        None
    }
}

pub fn quick_open(root: PathBuf, query: &str) -> Result<QuickOpen, String> {
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    path_string(&root)?;
    let query = query.to_lowercase().replace('\\', "/");
    let mut directories = vec![root.clone()];
    let mut best: Vec<(i64, FolderEntry)> = Vec::new();
    let mut visited = 0;
    let mut skipped_directories = 0;
    let started = std::time::Instant::now();
    let mut truncated = false;
    'scan: while let Some(directory) = directories.pop() {
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(_) => {
                skipped_directories += 1;
                continue;
            }
        };
        for entry in entries {
            if visited >= 50_000 || started.elapsed().as_millis() >= 1000 {
                truncated = true;
                break 'scan;
            }
            visited += 1;
            let Ok(entry) = entry else {
                skipped_directories += 1;
                continue;
            };
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if path.to_str().is_none() {
                truncated = true;
                continue;
            }
            if kind.is_dir() {
                if matches!(
                    entry.file_name().to_str(),
                    Some(".git" | "node_modules" | "target")
                ) {
                    continue;
                }
                directories.push(path);
            } else if kind.is_file() || (kind.is_symlink() && path.is_file()) {
                let relative = path.strip_prefix(&root).unwrap_or(&path).to_string_lossy();
                if let Some(score) = fuzzy_score(&relative, &query) {
                    let entry = FolderEntry {
                        name: relative.into_owned(),
                        path: path.to_string_lossy().into_owned(),
                        is_directory: false,
                        is_symlink: kind.is_symlink(),
                    };
                    let candidate = (score, entry);
                    let index = best.partition_point(|prior| {
                        prior.0 > candidate.0
                            || (prior.0 == candidate.0 && prior.1.name <= candidate.1.name)
                    });
                    if index < 80 {
                        best.insert(index, candidate);
                        best.truncate(80);
                    }
                }
            }
        }
    }
    Ok(QuickOpen {
        entries: best.into_iter().map(|(_, entry)| entry).collect(),
        truncated,
        skipped_directories,
    })
}

fn leaf_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
    {
        return Err(format!("Invalid file name: {name}"));
    }
    Ok(trimmed)
}

fn path_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "This path is not valid UTF-8. Manage it in the system file manager.".into())
}

fn canonical_path(path: &str) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|e| e.to_string())
}

// Resolve ancestors only: a folder action must act on the named link itself.
fn unresolved_leaf(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    let leaf = path
        .file_name()
        .ok_or("A filesystem root cannot be changed.")?;
    // Reject terminal `.` / `..`, which Path components otherwise normalize.
    if path.as_os_str() != path.with_file_name(leaf).as_os_str() {
        return Err("Choose a file or folder entry.".into());
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    Ok(fs::canonicalize(parent)
        .map_err(|e| e.to_string())?
        .join(leaf))
}

fn require_absent(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
        Ok(_) => Err(format!(
            "A file or folder named {} already exists.",
            path.file_name().unwrap_or_default().to_string_lossy()
        )),
    }
}

/// Create an empty file inside `parent`. Fails when the target already exists.
pub fn create_file(parent: String, name: String) -> Result<String, String> {
    let leaf = leaf_name(&name)?.to_owned();
    let parent = canonical_path(&parent)?;
    if !parent.is_dir() {
        return Err("The parent folder is no longer available.".into());
    }
    let target = parent.join(leaf);
    let result = path_string(&target)?;
    require_absent(&target)?;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| e.to_string())?;
    Ok(result)
}

/// Create a folder inside `parent`. Fails when the target already exists.
pub fn create_folder(parent: String, name: String) -> Result<String, String> {
    let leaf = leaf_name(&name)?.to_owned();
    let parent = canonical_path(&parent)?;
    if !parent.is_dir() {
        return Err("The parent folder is no longer available.".into());
    }
    let target = parent.join(leaf);
    let result = path_string(&target)?;
    require_absent(&target)?;
    fs::create_dir(&target).map_err(|e| e.to_string())?;
    Ok(result)
}

/// Rename `from` to a sibling leaf `name`. Never overwrites an existing path.
pub fn rename_path(from: String, name: String) -> Result<String, String> {
    let leaf = leaf_name(&name)?.to_owned();
    let from = unresolved_leaf(&from)?;
    fs::symlink_metadata(&from).map_err(|e| e.to_string())?;
    let parent = from
        .parent()
        .ok_or("This path cannot be renamed.")?
        .to_path_buf();
    let target = parent.join(leaf);
    if target == from {
        return path_string(&from);
    }
    let result = path_string(&target)?;
    require_absent(&target)?;
    fs::rename(&from, &target).map_err(|e| e.to_string())?;
    Ok(result)
}

/// Delete a file, symlink, or folder (recursively). The frontend confirms first.
pub fn delete_path(path: String) -> Result<(), String> {
    let path = unresolved_leaf(&path)?;
    if path.parent().is_none() {
        return Err("Refusing to delete a filesystem root.".into());
    }
    let kind = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if kind.is_symlink() {
        #[cfg(windows)]
        {
            use std::os::windows::fs::FileTypeExt;
            if kind.file_type().is_symlink_dir() {
                return fs::remove_dir(&path).map_err(|e| e.to_string());
            }
        }
        fs::remove_file(&path).map_err(|e| e.to_string())
    } else if kind.is_file() {
        fs::remove_file(&path).map_err(|e| e.to_string())
    } else if kind.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())
    } else {
        Err("Only files, symlinks, and folders can be deleted.".into())
    }
}

/// Reveal `path` in Finder, Explorer, or the Linux file manager. Best effort.
pub fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let path = canonical_path(&path)?;
    let is_dir = path.is_dir();
    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("open");
        if is_dir {
            command.arg(&path);
        } else {
            command.arg("-R").arg(&path);
        }
        command.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        if is_dir {
            std::process::Command::new("explorer")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("explorer")
                .arg(format!("/select,{}", path.to_string_lossy()))
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let target = if is_dir {
            path.clone()
        } else {
            path.parent()
                .ok_or("This path cannot be revealed.")?
                .to_path_buf()
        };
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
