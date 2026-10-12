mod document;
mod folder;
mod session;
use document::{Document, Info, Page, SearchResult, SearchScan};
use session::{RestoredSession, SessionStore, SessionView};
use std::time::Instant;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager, State};

struct StartupClock(Instant);

type SharedDocument = Arc<Mutex<Document>>;
#[derive(Default)]
struct Editor {
    documents: Mutex<HashMap<u64, SharedDocument>>,
    next_id: AtomicU64,
    startup: Mutex<Startup>,
}
#[derive(Default)]
struct Startup {
    ready: bool,
    exit_ready: bool,
    paths: Vec<String>,
}

impl Editor {
    fn id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }
    fn get(&self, id: u64) -> Result<SharedDocument, String> {
        self.documents
            .lock()
            .map_err(|e| e.to_string())?
            .get(&id)
            .cloned()
            .ok_or_else(|| "The document is no longer open.".into())
    }
    fn insert(&self, doc: Document) -> Result<(), String> {
        self.documents
            .lock()
            .map_err(|e| e.to_string())?
            .insert(doc.id, Arc::new(Mutex::new(doc)));
        Ok(())
    }
}
async fn work<T: Send + 'static>(
    doc: SharedDocument,
    action: impl FnOnce(&mut Document) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut doc = doc.lock().map_err(|e| e.to_string())?;
        action(&mut doc)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn new_document(editor: State<'_, Editor>) -> Result<Page, String> {
    let doc = Document::empty(editor.id());
    let page = doc.page(0)?;
    editor.insert(doc)?;
    Ok(page)
}
#[tauri::command]
async fn open_document(editor: State<'_, Editor>, path: String) -> Result<Page, String> {
    let id = editor.id();
    let (doc, page) = tauri::async_runtime::spawn_blocking(move || {
        let doc = Document::open(id, &PathBuf::from(path))?;
        let page = doc.page(0)?;
        Ok::<_, String>((doc, page))
    })
    .await
    .map_err(|e| e.to_string())??;
    editor.insert(doc)?;
    Ok(page)
}
#[tauri::command]
async fn read_directory(path: String) -> Result<folder::FolderListing, String> {
    tauri::async_runtime::spawn_blocking(move || folder::read_directory(PathBuf::from(path)))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn quick_open(path: String, query: String) -> Result<folder::QuickOpen, String> {
    tauri::async_runtime::spawn_blocking(move || folder::quick_open(PathBuf::from(path), &query))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn read_page(editor: State<'_, Editor>, id: u64, offset: u64) -> Result<Page, String> {
    work(editor.get(id)?, move |doc| doc.load_page(offset)).await
}
#[tauri::command]
async fn replace_range(
    editor: State<'_, Editor>,
    id: u64,
    start: u64,
    end: u64,
    text: String,
    revision: u64,
    mark_clean: Option<bool>,
) -> Result<Info, String> {
    work(editor.get(id)?, move |doc| {
        doc.replace(start, end, text, revision)?;
        if mark_clean == Some(true) {
            doc.mark_clean();
        }
        Ok(doc.info())
    })
    .await
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalChange {
    changed: bool,
    token: String,
}
#[tauri::command]
async fn check_external_change(
    editor: State<'_, Editor>,
    id: u64,
) -> Result<ExternalChange, String> {
    work(editor.get(id)?, |doc| {
        let (changed, token) = doc.external_change();
        Ok(ExternalChange { changed, token })
    })
    .await
}
#[tauri::command]
async fn document_history(
    editor: State<'_, Editor>,
    id: u64,
    redo: bool,
    offset: u64,
    revision: u64,
) -> Result<Page, String> {
    work(editor.get(id)?, move |doc| {
        doc.history(redo, offset, revision)
    })
    .await
}
#[derive(serde::Serialize)]
struct ReplaceResult {
    page: Page,
    count: u64,
}
#[derive(Clone, serde::Serialize)]
struct OperationProgress {
    id: u64,
    done: u64,
    total: u64,
}
#[tauri::command]
async fn replace_entire_file(
    app: tauri::AppHandle,
    editor: State<'_, Editor>,
    id: u64,
    query: String,
    replacement: String,
    revision: u64,
) -> Result<ReplaceResult, String> {
    work(editor.get(id)?, move |doc| {
        let (page, count) = doc.replace_all(&query, &replacement, revision, |done, total| {
            let _ = app.emit("document-progress", OperationProgress { id, done, total });
        })?;
        Ok(ReplaceResult { page, count })
    })
    .await
}
#[tauri::command]
async fn convert_document_indent(
    app: tauri::AppHandle,
    editor: State<'_, Editor>,
    id: u64,
    tabs: bool,
    width: u8,
    revision: u64,
) -> Result<Page, String> {
    work(editor.get(id)?, move |doc| {
        doc.convert_indent(tabs, width, revision, |done, total| {
            let _ = app.emit("document-progress", OperationProgress { id, done, total });
        })
    })
    .await
}
#[tauri::command]
async fn save_document(
    editor: State<'_, Editor>,
    id: u64,
    path: Option<String>,
) -> Result<Info, String> {
    work(editor.get(id)?, move |doc| {
        doc.save(path.map(PathBuf::from))
    })
    .await
}
#[tauri::command]
async fn search_document(
    editor: State<'_, Editor>,
    id: u64,
    query: String,
    start: u64,
) -> Result<SearchResult, String> {
    work(editor.get(id)?, move |doc| doc.search(&query, start)).await
}
#[tauri::command]
async fn scan_search(
    editor: State<'_, Editor>,
    id: u64,
    query: String,
    start: u64,
    anchor: u64,
) -> Result<SearchScan, String> {
    work(editor.get(id)?, move |doc| {
        doc.scan_search(&query, start, anchor)
    })
    .await
}
#[tauri::command]
fn close_document(editor: State<'_, Editor>, id: u64) -> Result<(), String> {
    editor
        .documents
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    Ok(())
}
#[tauri::command]
async fn restore_session(app: tauri::AppHandle) -> Result<RestoredSession, String> {
    app.state::<Editor>()
        .startup
        .lock()
        .map_err(|e| e.to_string())?
        .exit_ready = true;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<SessionStore>().restore(&app.state::<Editor>())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn persist_session(app: tauri::AppHandle, view: SessionView) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<SessionStore>()
            .save(&app.state::<Editor>(), view)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn file_view_ready(id: u64, elapsed_ms: f64, clock: State<'_, StartupClock>) {
    if std::env::var_os("RSEDIT_PROFILE_STARTUP").is_some() {
        eprintln!(
            "rsedit: document {id} view ready in {elapsed_ms:.1} ms; {:.1} ms from Rust entry",
            clock.0.elapsed().as_secs_f64() * 1000.0
        );
    }
}
#[tauri::command]
async fn startup_paths(
    editor: State<'_, Editor>,
    clock: State<'_, StartupClock>,
) -> Result<Vec<String>, String> {
    if std::env::var_os("RSEDIT_PROFILE_STARTUP").is_some() {
        eprintln!(
            "rsedit: editor ready in {:.1} ms",
            clock.0.elapsed().as_secs_f64() * 1000.0
        );
    }
    let mut paths = {
        let mut startup = editor.startup.lock().map_err(|e| e.to_string())?;
        startup.ready = true;
        std::mem::take(&mut startup.paths)
    };
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    paths.extend(
        tauri::async_runtime::spawn_blocking(move || {
            args.into_iter()
                .filter_map(|arg| {
                    let path = PathBuf::from(arg);
                    path.is_file().then(|| path.to_string_lossy().into_owned())
                })
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|e| e.to_string())?,
    );
    Ok(paths)
}

fn menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let item = |id: &str, label: &str, accelerator: &str| {
        MenuItemBuilder::with_id(id, label)
            .accelerator(accelerator)
            .build(app)
    };
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new", "New File", "CmdOrCtrl+N")?)
        .item(&item("open", "Open…", "CmdOrCtrl+O")?)
        .item(&item("open-folder", "Open Folder…", "CmdOrCtrl+Alt+O")?)
        .separator()
        .item(&item("save", "Save", "CmdOrCtrl+S")?)
        .item(&item("save-as", "Save As…", "CmdOrCtrl+Shift+S")?)
        .separator()
        .item(&item("close", "Close File", "CmdOrCtrl+W")?)
        .item(&item("reopen", "Reopen Closed File", "CmdOrCtrl+Shift+T")?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&item("undo", "Undo", "CmdOrCtrl+Z")?)
        .item(&item("redo", "Redo", "CmdOrCtrl+Shift+Z")?)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item("find", "Find / Replace", "CmdOrCtrl+F")?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item("palette", "Command Palette", "CmdOrCtrl+Shift+P")?)
        .text("wrap", "Toggle Word Wrap")
        .text("theme", "Toggle Theme")
        .text("toggle-folder", "Toggle Folder Panel")
        .build()?;
    let app_menu = SubmenuBuilder::new(app, "rsedit").about(None).separator();
    #[cfg(target_os = "macos")]
    let app_menu = app_menu.hide().hide_others().show_all().separator();
    let app_menu = app_menu
        .item(&item("quit", "Quit rsedit", "CmdOrCtrl+Q")?)
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view])
        .build()
}

pub fn run() {
    let started = Instant::now();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Editor::default())
        .manage(StartupClock(started))
        .setup(|app| {
            app.manage(SessionStore::new(
                app.path().app_data_dir()?.join("session"),
            ));
            Ok(())
        })
        .menu(menu)
        .on_menu_event(|app, event| {
            let _ = app.emit("editor-menu", event.id().as_ref());
        })
        .invoke_handler(tauri::generate_handler![
            new_document,
            open_document,
            read_directory,
            read_page,
            replace_range,
            save_document,
            check_external_change,
            document_history,
            replace_entire_file,
            convert_document_indent,
            quick_open,
            search_document,
            scan_search,
            close_document,
            startup_paths,
            file_view_ready,
            restore_session,
            persist_session
        ])
        .build(tauri::generate_context!())
        .expect("Could not start rsedit");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. }
            if !app.webview_windows().is_empty()
                && app
                    .state::<Editor>()
                    .startup
                    .lock()
                    .map(|s| s.exit_ready)
                    .unwrap_or(false) =>
        {
            // Route Dock/system quit through the session checkpoint before closing.
            api.prevent_exit();
            let _ = app.emit("editor-menu", "quit");
        }
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        tauri::RunEvent::Opened { urls } => {
            let paths: Vec<String> = urls
                .into_iter()
                .filter_map(|url| url.to_file_path().ok())
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            let editor = app.state::<Editor>();
            if let Ok(mut startup) = editor.startup.lock() {
                if startup.ready {
                    let _ = app.emit("editor-open", &paths);
                } else {
                    startup.paths.extend(paths);
                }
            };
        }
        _ => (),
    });
}
