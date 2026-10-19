mod cli;
mod document;
mod folder;
mod session;
use cli::OpenRequest;
use document::{Document, Info, Page, SearchScan};
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
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

const WINDOW_STATE_FLAGS: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED)
    .union(StateFlags::FULLSCREEN);

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
    requests: Vec<OpenRequest>,
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
    let mut doc = Document::empty(editor.id());
    let page = doc.page(0)?;
    editor.insert(doc)?;
    Ok(page)
}
#[tauri::command]
async fn open_document(
    editor: State<'_, Editor>,
    path: String,
    create_if_missing: Option<bool>,
) -> Result<Page, String> {
    let id = editor.id();
    let (doc, page) = tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        let mut doc = if create_if_missing.unwrap_or(false) {
            Document::open_or_new(id, &path)?
        } else {
            Document::open(id, &path)?
        };
        let page = doc.page(0)?;
        Ok::<_, String>((doc, page))
    })
    .await
    .map_err(|e| e.to_string())??;
    editor.insert(doc)?;
    Ok(page)
}
#[tauri::command]
async fn open_stdin(editor: State<'_, Editor>, path: String) -> Result<Page, String> {
    let id = editor.id();
    let (doc, page) = tauri::async_runtime::spawn_blocking(move || {
        let mut doc = Document::from_stdin(id, &PathBuf::from(path))?;
        let page = doc.page(0)?;
        Ok::<_, String>((doc, page))
    })
    .await
    .map_err(|e| e.to_string())??;
    editor.insert(doc)?;
    Ok(page)
}
#[tauri::command]
async fn document_location(
    editor: State<'_, Editor>,
    id: u64,
    line: u64,
    col: u64,
) -> Result<u64, String> {
    work(editor.get(id)?, move |doc| doc.location_offset(line, col)).await
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
async fn create_file(parent: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || folder::create_file(parent, name))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn create_folder(parent: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || folder::create_folder(parent, name))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn rename_path(from: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || folder::rename_path(from, name))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn delete_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || folder::delete_path(path))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn reveal_in_file_manager(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || folder::reveal_in_file_manager(path))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn retarget_document(
    editor: State<'_, Editor>,
    id: u64,
    path: String,
) -> Result<Info, String> {
    work(editor.get(id)?, move |doc| {
        doc.retarget(PathBuf::from(path))
    })
    .await
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
fn startup_paths(
    editor: State<'_, Editor>,
    clock: State<'_, StartupClock>,
) -> Result<Vec<OpenRequest>, String> {
    if std::env::var_os("RSEDIT_PROFILE_STARTUP").is_some() {
        eprintln!(
            "rsedit: editor ready in {:.1} ms",
            clock.0.elapsed().as_secs_f64() * 1000.0
        );
    }
    let mut startup = editor.startup.lock().map_err(|e| e.to_string())?;
    startup.ready = true;
    Ok(std::mem::take(&mut startup.requests))
}

#[tauri::command]
fn pending_open_requests(editor: State<'_, Editor>) -> Result<Vec<OpenRequest>, String> {
    let mut startup = editor.startup.lock().map_err(|e| e.to_string())?;
    Ok(std::mem::take(&mut startup.requests))
}

fn dispatch_open(app: &tauri::AppHandle, requests: Vec<OpenRequest>) {
    if requests.is_empty() {
        return;
    }
    let editor = app.state::<Editor>();
    if let Ok(mut startup) = editor.startup.lock() {
        startup.requests.extend(requests);
        if startup.ready {
            match app.emit("editor-open", &startup.requests) {
                Ok(()) => startup.requests.clear(),
                Err(error) => eprintln!("rsedit: could not deliver launch requests: {error}"),
            }
        }
    };
}

fn focus_editor(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn persist_window_state(app: tauri::AppHandle) -> Result<(), String> {
    app.save_window_state(WINDOW_STATE_FLAGS)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_word_wrap_menu(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let item = app
        .menu()
        .and_then(|menu| menu.get("view"))
        .and_then(|item| item.as_submenu()?.get("wrap"))
        .ok_or("The Word Wrap menu item is unavailable.")?;
    item.as_check_menuitem()
        .ok_or("The Word Wrap menu item is not checkable.")?
        .set_checked(enabled)
        .map_err(|e| e.to_string())
}

fn menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    // Application shortcuts belong to the frontend capture handler. Registering
    // them here too can swallow webview key events or execute commands twice.
    // Native text editing and OS menu items keep their standard accelerators.
    let item = |id: &str, label: &str| MenuItemBuilder::with_id(id, label).build(app);
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new", "New File")?)
        .item(&item("open", "Open…")?)
        .item(&item("open-folder", "Open Folder…")?)
        .separator()
        .item(&item("save", "Save")?)
        .item(&item("save-as", "Save As…")?)
        .separator()
        .item(&item("close", "Close File")?)
        .item(&item("reopen", "Reopen Closed File")?);
    #[cfg(not(target_os = "macos"))]
    let file = file.separator().item(&item("quit", "Quit rsedit")?);
    let file = file.build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&item("undo", "Undo")?)
        .item(&item("redo", "Redo")?)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item("find", "Find / Replace")?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .id("view")
        .item(&item("palette", "Command Palette")?)
        .item(
            &CheckMenuItemBuilder::with_id("wrap", "Word Wrap")
                .checked(true)
                .build(app)?,
        )
        .text("theme", "Next Theme")
        .text("select-theme", "Select Theme…")
        .text("toggle-folder", "Toggle Folder Panel")
        .separator()
        // Font shortcuts are handled by the frontend across keyboard layouts.
        .text("increase-font-size", "Increase Font Size")
        .text("decrease-font-size", "Decrease Font Size")
        .text("reset-font-size", "Reset Font Size")
        .separator()
        .text("split", "Split Editor Right")
        .text("focus-other", "Focus Other Pane")
        .text("move-to-other", "Move Current Tab to Other Pane")
        .text("close-split", "Close Split")
        .build()?;
    let menu = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    let menu = menu.item(
        &SubmenuBuilder::new(app, "rsedit")
            .about(None)
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .item(&item("quit", "Quit rsedit")?)
            .build()?,
    );
    let menu = menu.items(&[&file, &edit, &view]);
    #[cfg(not(target_os = "macos"))]
    let menu = menu.item(&SubmenuBuilder::new(app, "Help").about(None).build()?);
    menu.build()
}

pub fn run() {
    let started = Instant::now();
    match cli::forward_stdin() {
        Ok(Some(code)) => std::process::exit(code),
        Err(error) => {
            eprintln!("rsedit: {error}");
            std::process::exit(1);
        }
        Ok(None) => (),
    }
    let editor = Editor::default();
    editor
        .startup
        .lock()
        .expect("Could not initialize launch requests")
        .requests = cli::requests(
        std::env::args_os().skip(1),
        &std::env::current_dir().expect("Could not resolve the launch directory"),
    );
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            focus_editor(app);
            dispatch_open(
                app,
                cli::requests(
                    args.into_iter().skip(1).map(Into::into),
                    &PathBuf::from(cwd),
                ),
            );
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(WINDOW_STATE_FLAGS)
                .build(),
        )
        .manage(editor)
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
            open_stdin,
            document_location,
            read_directory,
            read_page,
            replace_range,
            save_document,
            check_external_change,
            document_history,
            replace_entire_file,
            convert_document_indent,
            quick_open,
            create_file,
            create_folder,
            rename_path,
            delete_path,
            reveal_in_file_manager,
            retarget_document,
            scan_search,
            close_document,
            startup_paths,
            pending_open_requests,
            file_view_ready,
            restore_session,
            persist_session,
            persist_window_state,
            set_word_wrap_menu
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
            let requests = urls
                .into_iter()
                .filter_map(|url| url.to_file_path().ok())
                .map(|path| cli::path_request(path.into_os_string(), &PathBuf::new()))
                .collect();
            focus_editor(app);
            dispatch_open(app, requests);
        }
        _ => (),
    });
}
