use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    name: String,
    path: String,
    is_directory: bool,
}

#[derive(Serialize)]
pub struct FolderListing {
    name: String,
    path: String,
    entries: Vec<FolderEntry>,
}

pub fn read_directory(path: PathBuf) -> Result<FolderListing, String> {
    let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
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
        path: path.to_string_lossy().into_owned(),
        entries,
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
    let query = query.to_lowercase().replace('\\', "/");
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
                if let Some(score) = fuzzy_score(&relative, query) {
                    let entry = FolderEntry {
                        name: relative.into_owned(),
                        path: path.to_string_lossy().into_owned(),
                        is_directory: false,
                    };
                    best.push((score, entry));
                    best.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.name.cmp(&b.1.name)));
                    best.truncate(80);
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
