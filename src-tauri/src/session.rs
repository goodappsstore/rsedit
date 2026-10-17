//! Hot exit snapshots. The index is replaced only after every buffer is synced.
use crate::{
    document::{Document, Info, SavedDocument, SnapshotSources},
    Editor,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tempfile::{Builder, NamedTempFile};

const MANIFEST_LIMIT: u64 = 16 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabView {
    pub id: u64,
    pub name: String,
    pub page_start: u64,
    pub anchor: usize,
    pub head: usize,
    pub scroll_top: f64,
    pub scroll_left: f64,
    pub language_override: Option<String>,
    #[serde(default)]
    pub indent: Option<String>,
    #[serde(default)]
    pub tab_size: Option<u8>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub open: Vec<TabView>,
    pub closed: Vec<TabView>,
    pub active: Option<u64>,
    #[serde(default)]
    pub secondary: Option<u64>,
    #[serde(default)]
    pub folder: Option<FolderView>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct FolderView {
    pub path: String,
    pub visible: bool,
}
#[derive(Serialize)]
pub struct RestoredTab {
    pub info: Info,
    pub view: TabView,
}
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RestoredSession {
    pub open: Vec<RestoredTab>,
    pub closed: Vec<RestoredTab>,
    pub active_index: usize,
    pub secondary_index: Option<usize>,
    pub folder: Option<FolderView>,
    pub errors: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct SavedTab {
    document: SavedDocument,
    view: TabView,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedSession {
    version: u32,
    open: Vec<SavedTab>,
    closed: Vec<SavedTab>,
    active_index: usize,
    #[serde(default)]
    secondary_index: Option<usize>,
    #[serde(default)]
    folder: Option<FolderView>,
}
#[derive(Default)]
enum LoadState {
    #[default]
    Pending,
    Ready,
    Unavailable(String),
}
#[derive(Default)]
struct StoreState {
    lock: Option<File>,
    loaded: LoadState,
    unrestored_open: Vec<SavedTab>,
    unrestored_closed: Vec<SavedTab>,
    sources: SnapshotSources,
    snapshots: std::collections::HashMap<u64, ((u64, bool), SavedDocument)>,
}
pub struct SessionStore {
    directory: PathBuf,
    state: Mutex<StoreState>,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
impl SessionStore {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            state: Mutex::new(StoreState::default()),
        }
    }
    fn acquire(&self, state: &mut StoreState) -> Result<(), String> {
        if state.lock.is_none() {
            fs::create_dir_all(&self.directory).map_err(err)?;
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(self.directory.join("session.lock"))
                .map_err(err)?;
            lock.try_lock()
                .map_err(|e| format!("Session storage is in use by another rsedit process: {e}"))?;
            state.lock = Some(lock);
        }
        Ok(())
    }
    // Keep each failed session in its own directory, retaining relative paths.
    // The marker lets startup finish an archive interrupted between renames.
    fn finish_preservation(&self, archive: &Path) -> Result<(), String> {
        let manifest = self.directory.join("session.json");
        if manifest.try_exists().map_err(err)? {
            fs::rename(&manifest, archive.join("session.json")).map_err(err)?;
        }
        for entry in fs::read_dir(&self.directory).map_err(err)? {
            let entry = entry.map_err(err)?;
            if entry.file_name().to_string_lossy().starts_with("buffers-") {
                fs::rename(entry.path(), archive.join(entry.file_name())).map_err(err)?;
            }
        }
        fs::remove_file(archive.join("preserving")).map_err(err)
    }
    fn finish_pending_preservations(&self) -> Result<(), String> {
        for entry in fs::read_dir(&self.directory).map_err(err)? {
            let entry = entry.map_err(err)?;
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with("preserved-")
                && entry.file_type().map_err(err)?.is_dir()
                && entry.path().join("preserving").try_exists().map_err(err)?
            {
                self.finish_preservation(&entry.path())?;
            }
        }
        Ok(())
    }
    fn preserve_previous(&self, reason: String) -> Result<RestoredSession, String> {
        let archive = Builder::new()
            .prefix("preserved-")
            .tempdir_in(&self.directory)
            .map_err(err)?;
        File::create(archive.path().join("preserving"))
            .map_err(err)?
            .sync_all()
            .map_err(err)?;
        let archive = archive.keep();
        self.finish_preservation(&archive).map_err(|error| {
            format!(
                "Could not archive the previous session: {error}. Its data remains in {} and {}.",
                self.directory.display(),
                archive.display()
            )
        })?;
        Ok(RestoredSession {
            errors: vec![format!("{reason} The previous manifest and buffers were preserved in {}. A fresh session has started.", archive.display())],
            ..RestoredSession::default()
        })
    }
    pub fn restore(&self, editor: &Editor) -> Result<RestoredSession, String> {
        let mut state = self.state.lock().map_err(err)?;
        if matches!(state.loaded, LoadState::Ready) {
            return Err("The session has already been restored.".into());
        }
        let result = self.restore_locked(editor, &mut state);
        state.loaded = match &result {
            Ok(_) => LoadState::Ready,
            Err(error) => LoadState::Unavailable(error.clone()),
        };
        result
    }
    fn restore_locked(
        &self,
        editor: &Editor,
        state: &mut StoreState,
    ) -> Result<RestoredSession, String> {
        self.acquire(state)?;
        self.finish_pending_preservations()?;
        let saved: SavedSession = match File::open(self.directory.join("session.json")) {
            Ok(file) => {
                if file.metadata().map_err(err)?.len() > MANIFEST_LIMIT {
                    drop(file);
                    return self
                        .preserve_previous("The previous session manifest exceeds 16 MiB.".into());
                }
                match serde_json::from_reader(file.take(MANIFEST_LIMIT + 1)) {
                    Ok(saved) => saved,
                    Err(error) => {
                        return self.preserve_previous(format!(
                            "Could not read the previous session: {error}."
                        ))
                    }
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => SavedSession {
                version: 2,
                open: vec![],
                closed: vec![],
                active_index: 0,
                secondary_index: None,
                folder: None,
            },
            Err(e) => {
                return self.preserve_previous(format!("Could not open the previous session: {e}."))
            }
        };
        if ![1, 2].contains(&saved.version) {
            return self.preserve_previous("Unrecognized session format.".into());
        }
        let mut restored = RestoredSession {
            folder: saved.folder,
            ..RestoredSession::default()
        };
        for (closed, entries) in [(false, saved.open), (true, saved.closed)] {
            for (index, mut entry) in entries.into_iter().enumerate() {
                match Document::recover(editor.id(), &entry.document, &self.directory) {
                    Ok(doc) => {
                        let info = doc.info();
                        if entry.document.buffer.is_some() || entry.document.pieces.is_some() {
                            state.sources.register_recovery(&doc, &entry.document);
                            state.snapshots.insert(
                                info.id,
                                ((info.revision, info.dirty), entry.document.clone()),
                            );
                        }
                        entry.view.id = info.id;
                        editor.insert(doc)?;
                        if closed {
                            restored.closed.push(RestoredTab {
                                info,
                                view: entry.view,
                            });
                        } else {
                            if index == saved.active_index {
                                restored.active_index = restored.open.len();
                            }
                            if Some(index) == saved.secondary_index {
                                restored.secondary_index = Some(restored.open.len());
                            }
                            restored.open.push(RestoredTab {
                                info,
                                view: entry.view,
                            });
                        }
                    }
                    // Clean files may have been moved or deleted between sessions.
                    // Drop stale entries, but preserve failures involving recovery data.
                    Err(_) if entry.document.missing_source_file() => {}
                    Err(error) => {
                        restored
                            .errors
                            .push(format!("Could not restore {}: {error}", entry.view.name));
                        if closed {
                            state.unrestored_closed.push(entry);
                        } else {
                            state.unrestored_open.push(entry);
                        }
                    }
                }
            }
        }
        Ok(restored)
    }
    pub fn save(&self, editor: &Editor, view: SessionView) -> Result<(), String> {
        if view.closed.len() > 50 {
            return Err("Closed-file history exceeds 50 entries.".into());
        }
        let mut ids = std::collections::HashSet::new();
        if !view
            .open
            .iter()
            .chain(&view.closed)
            .all(|tab| ids.insert(tab.id))
        {
            return Err(
                "The session contains duplicate tabs. Its previous snapshot has been preserved."
                    .into(),
            );
        }
        let mut state = self.state.lock().map_err(err)?;
        self.acquire(&mut state)?;
        match &state.loaded {
            LoadState::Ready => (),
            LoadState::Unavailable(error) => {
                return Err(format!("Session storage is unavailable: {error}"))
            }
            LoadState::Pending => return Err("The previous session has not been restored.".into()),
        }
        let stage = Builder::new()
            .prefix("buffers-")
            .tempdir_in(&self.directory)
            .map_err(err)?;
        let relative = Path::new(
            stage
                .path()
                .file_name()
                .ok_or("Invalid buffer directory.")?,
        );
        let active_index = view
            .open
            .iter()
            .position(|tab| Some(tab.id) == view.active)
            .unwrap_or(0);
        let secondary_index = view
            .open
            .iter()
            .position(|tab| Some(tab.id) == view.secondary);
        let mut saved = SavedSession {
            version: 2,
            open: vec![],
            closed: vec![],
            active_index,
            secondary_index,
            folder: view.folder,
        };
        let mut sources = state.sources.clone();
        let mut snapshots = std::collections::HashMap::new();
        let mut failures = Vec::new();
        let mut documents = Vec::new();
        for (closed, entries) in [(false, view.open), (true, view.closed)] {
            for tab in entries {
                let shared = editor.get(tab.id)?;
                // Capture immutable pieces briefly; disk streaming must not block editing.
                let doc = shared.lock().map_err(err)?.clone();
                let result = (|| {
                    let key = doc.checkpoint_key()?;
                    let document = match state.snapshots.get(&tab.id) {
                        Some((prior_key, saved)) if *prior_key == key => saved.clone(),
                        _ => doc.snapshot(stage.path(), relative, &mut sources)?,
                    };
                    Ok::<_, String>((key, document))
                })();
                let (key, document) = match result {
                    Ok(snapshot) => snapshot,
                    Err(error) => {
                        let Some(previous) = state.snapshots.get(&tab.id) else {
                            return Err(format!("Could not preserve {}: {error}", tab.name));
                        };
                        failures.push(format!("{}: {error} Its last successful checkpoint was retained; newer edits are not saved.", tab.name));
                        previous.clone()
                    }
                };
                documents.push(shared);
                snapshots.insert(tab.id, (key, document.clone()));
                let entry = SavedTab {
                    document,
                    view: tab,
                };
                if closed {
                    saved.closed.push(entry);
                } else {
                    saved.open.push(entry);
                }
            }
        }
        // Failed restores retain their original references rather than losing data
        // when a later session is saved successfully.
        saved.open.extend(state.unrestored_open.iter().cloned());
        saved.closed.extend(state.unrestored_closed.iter().cloned());
        let mut index = NamedTempFile::new_in(&self.directory).map_err(err)?;
        serde_json::to_writer(&mut index, &saved).map_err(err)?;
        index.flush().map_err(err)?;
        if index.as_file().metadata().map_err(err)?.len() > MANIFEST_LIMIT {
            return Err("The session manifest exceeds 16 MiB. The previous checkpoint was retained; save buffers to files and reduce open/closed history.".into());
        }
        index.as_file().sync_all().map_err(err)?;
        let _kept = stage.keep();
        index
            .persist(self.directory.join("session.json"))
            .map_err(err)?;
        state.snapshots = snapshots;
        let paths = saved
            .open
            .iter()
            .chain(&saved.closed)
            .flat_map(|tab| tab.document.buffers().cloned())
            .collect();
        sources.retain(&paths);
        for shared in documents {
            match shared.lock() {
                Ok(mut doc) => {
                    if let Err(error) = sources.protect(&mut doc, &self.directory) {
                        failures.push(format!(
                            "Could not attach the completed recovery copy: {error}"
                        ));
                    }
                }
                Err(error) => failures.push(err(error)),
            }
        }
        state.sources = sources;
        let result = if failures.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "Available recovery data was preserved, but some buffers need attention: {}",
                failures.join("\n")
            ))
        };
        // Only reclaim generations absent from the newly committed manifest.
        let keep: std::collections::HashSet<_> = saved
            .open
            .iter()
            .chain(&saved.closed)
            .flat_map(|tab| tab.document.buffers())
            .filter_map(|path| path.components().next())
            .map(|c| c.as_os_str().to_os_string())
            .collect();
        if !state.unrestored_open.is_empty() || !state.unrestored_closed.is_empty() {
            return result;
        }
        if let Ok(entries) = fs::read_dir(&self.directory) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with("buffers-")
                    && !keep.contains(&entry.file_name())
                    && entry.file_type().is_ok_and(|kind| kind.is_dir())
                {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
        result
    }
}
