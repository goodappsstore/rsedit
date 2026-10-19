use serde::Serialize;
use std::{
    ffi::OsString,
    io::{self, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const STDIN_ARG: &str = "--rsedit-stdin=";
const MAX_POSITION: u64 = 9_007_199_254_740_991;

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpenRequest {
    File {
        path: String,
        line: Option<u64>,
        col: Option<u64>,
    },
    Folder {
        path: String,
    },
    Stdin {
        path: String,
    },
    Error {
        message: String,
    },
}

fn absolute(path: &Path, cwd: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_owned()
    } else {
        cwd.join(path)
    }
}

fn position(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value
        .parse()
        .ok()
        .filter(|n| (1..=MAX_POSITION).contains(n))
}

pub fn path_request(arg: OsString, cwd: &Path) -> OpenRequest {
    let literal = absolute(Path::new(&arg), cwd);
    // Existing names containing colons take precedence over location syntax.
    let (path, line, col) = if literal.exists() {
        (literal, None, None)
    } else if let Some((prefix, last)) = arg.to_str().and_then(|s| s.rsplit_once(':')) {
        if let Some(last) = position(last) {
            if let Some((file, line)) = prefix
                .rsplit_once(':')
                .and_then(|(file, n)| position(n).map(|n| (file, n)))
            {
                (absolute(Path::new(file), cwd), Some(line), Some(last))
            } else {
                (absolute(Path::new(prefix), cwd), Some(last), None)
            }
        } else {
            (literal, None, None)
        }
    } else {
        (literal, None, None)
    };
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    // Resolve the parent for new files too, so ./name and symlinked directories
    // identify the same buffer when another launch reaches the running window.
    let path = path
        .parent()
        .and_then(|parent| std::fs::canonicalize(parent).ok())
        .zip(path.file_name())
        .map(|(parent, name)| parent.join(name))
        .unwrap_or(path);
    let name = path.to_string_lossy().into_owned();
    if path.is_dir() && line.is_none() {
        OpenRequest::Folder { path: name }
    } else if path.is_file()
        || (std::fs::symlink_metadata(&path)
            .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
            && path.parent().is_some_and(Path::is_dir)
            && path.file_name().is_some())
    {
        OpenRequest::File {
            path: name,
            line,
            col,
        }
    } else {
        OpenRequest::Error {
            message: format!(
                "Could not open {name}: choose a text file or a new filename in an existing directory."
            ),
        }
    }
}

pub fn requests(args: impl IntoIterator<Item = OsString>, cwd: &Path) -> Vec<OpenRequest> {
    let mut literal = false;
    args.into_iter()
        .filter_map(|arg| {
            if let Some(path) = arg
                .to_str()
                .filter(|_| !literal)
                .and_then(|s| s.strip_prefix(STDIN_ARG))
            {
                return Some(OpenRequest::Stdin {
                    path: path.to_owned(),
                });
            }
            if !literal && arg == "--" {
                literal = true;
                return None;
            }
            if !literal {
                // Finder's legacy process serial number is not a file argument.
                if arg.to_str().is_some_and(|s| s.starts_with("-psn_")) {
                    return None;
                }
            }
            Some(path_request(arg, cwd))
        })
        .collect()
}

/// The single-instance plugin forwards argv, not stdin. Spool before starting
/// Tauri and launch with a private argument that both startup and reuse consume.
pub fn forward_stdin() -> Result<Option<i32>, String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if !args
        .iter()
        .take_while(|arg| *arg != "--")
        .any(|arg| arg == "-")
    {
        return Ok(None);
    }
    let mut input = tempfile::Builder::new()
        .prefix("rsedit-stdin-")
        .tempfile()
        .map_err(|e| e.to_string())?;
    io::copy(&mut io::stdin().lock(), &mut input).map_err(|e| e.to_string())?;
    input.flush().map_err(|e| e.to_string())?;
    let (file, path) = input.keep().map_err(|e| e.to_string())?;
    drop(file);
    let result = (|| {
        let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
        let mut used_stdin = false;
        let mut literal = false;
        for arg in args {
            if arg == "--" {
                literal = true;
            }
            if !literal && arg == "-" {
                if used_stdin {
                    continue;
                }
                used_stdin = true;
                let mut forwarded = OsString::from(STDIN_ARG);
                forwarded.push(&path);
                command.arg(forwarded);
            } else {
                command.arg(arg);
            }
        }
        command
            .stdin(Stdio::null())
            .status()
            .map_err(|e| e.to_string())
    })();
    match result {
        Ok(status) if status.success() => Ok(Some(0)),
        Ok(status) => {
            let _ = std::fs::remove_file(path);
            Ok(Some(status.code().unwrap_or(1)))
        }
        Err(error) => {
            let _ = std::fs::remove_file(path);
            Err(error)
        }
    }
}
