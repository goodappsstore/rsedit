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
