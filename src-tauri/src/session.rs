//! Hot exit snapshots. The index is replaced only after every buffer is synced.
use crate::{
    document::{Document, Info, SavedDocument, SnapshotSources},
    Editor,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tempfile::{Builder, NamedTempFile};

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
struct StoreState {
    lock: Option<File>,
    loaded: bool,
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
    pub fn restore(&self, editor: &Editor) -> Result<RestoredSession, String> {
        let mut state = self.state.lock().map_err(err)?;
        self.acquire(&mut state)?;
        if state.loaded {
            return Err("The session has already been restored.".into());
        }
        let saved: SavedSession = match File::open(self.directory.join("session.json")) {
            Ok(file) => serde_json::from_reader(file).map_err(|e| {
                format!("Could not read the previous session. Its buffers have been preserved: {e}")
            })?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => SavedSession {
                version: 2,
                open: vec![],
                closed: vec![],
                active_index: 0,
                secondary_index: None,
                folder: None,
            },
            Err(e) => return Err(err(e)),
        };
        if ![1, 2].contains(&saved.version) {
            return Err(
                "Unrecognized session format. The previous session has been preserved.".into(),
            );
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
        state.loaded = true;
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
        if !state.loaded {
            return Err("The previous session was not restored. Quit was cancelled to protect its saved buffers.".into());
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
        for (closed, entries) in [(false, view.open), (true, view.closed)] {
            for tab in entries {
                let shared = editor.get(tab.id)?;
                // Capture immutable pieces briefly; disk streaming must not block editing.
                let doc = shared.lock().map_err(err)?.clone();
                let key = doc.checkpoint_key()?;
                let document = match state.snapshots.get(&tab.id) {
                    Some((prior_key, saved)) if *prior_key == key => saved.clone(),
                    _ => doc.snapshot(stage.path(), relative, &mut sources)?,
                };
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
        state.sources = sources;
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
            return Ok(());
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
        Ok(())
    }
}
