use crate::adapter;
use crate::reaper::{self, Tracker};
use std::io::{BufRead, BufReader};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::thread;
use tauri::{AppHandle, Emitter};

/// Resolve `~/.pixel-agents/bus.sock`, creating the parent dir if missing.
pub fn socket_path() -> Option<PathBuf> {
    let mut p = dirs::home_dir()?;
    p.push(".pixel-agents");
    if !p.exists() {
        let _ = std::fs::create_dir_all(&p);
    }
    p.push("bus.sock");
    Some(p)
}

/// Spawn a background thread that accepts connections on the UDS and forwards
/// line-delimited JSON payloads to the webview as `agent-event` events.
pub fn spawn_listener(app: AppHandle, tracker: Tracker) {
    let Some(path) = socket_path() else {
        eprintln!("[pixel-agents ipc] cannot resolve home dir; listener disabled");
        return;
    };

    // If another pixel-agents instance is already listening (dev build +
    // release bundle both launched, or a leftover process), don't clobber
    // its socket — otherwise we pull the file node out from under them,
    // leaving the old FD orphaned and future `connect()`s returning
    // ECONNREFUSED even after we exit. Probe first; only rebind when the
    // socket is stale (no listener on the other end).
    if UnixStream::connect(&path).is_ok() {
        eprintln!(
            "[pixel-agents ipc] another instance is already listening at {:?}; \
             skipping listener to avoid socket clobber",
            path
        );
        return;
    }
    let _ = std::fs::remove_file(&path);

    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[pixel-agents ipc] bind failed at {:?}: {}", path, e);
            return;
        }
    };

    println!("[pixel-agents ipc] listening on {:?}", path);

    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let app = app.clone();
                    let tracker = tracker.clone();
                    thread::spawn(move || handle_client(app, tracker, stream));
                }
                Err(e) => {
                    eprintln!("[pixel-agents ipc] accept error: {}", e);
                }
            }
        }
    });
}

fn handle_client(app: AppHandle, tracker: Tracker, stream: UnixStream) {
    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let Ok(line) = line else { continue };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let raw: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[pixel-agents ipc] bad json: {} (raw={})", e, trimmed);
                continue;
            }
        };
        let Some(event) = adapter::normalize(&raw) else {
            eprintln!("[pixel-agents ipc] unrecognized payload: {}", trimmed);
            continue;
        };
        println!(
            "[pixel-agents ipc] event kind={} tool={:?} session={} pid={:?} source={}",
            event.kind, event.tool, event.session_id, event.pid, event.source
        );
        // Keep the liveness tracker current: record the pid on every hook
        // (the CLI's PID is stable for the session), and drop the entry on a
        // real session_end so the reaper doesn't fire a duplicate.
        if let Some(pid) = event.pid {
            reaper::note_alive(&tracker, &event.session_id, pid);
        }
        if event.kind == "session_end" {
            reaper::note_gone(&tracker, &event.session_id);
        }
        if let Err(e) = app.emit("agent-event", &event) {
            eprintln!("[pixel-agents ipc] emit failed: {}", e);
        }
    }
}
