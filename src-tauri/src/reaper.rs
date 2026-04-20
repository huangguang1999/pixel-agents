//! Crash/SIGKILL detection for CLI-agent sessions.
//!
//! Claude Code (and peer CLIs) fire a `SessionEnd` hook on clean exit, but not
//! when the process is killed hard. Without this, an agent sprite lingers in
//! the room forever. The reaper tracks the shim's parent PID (= the CLI's own
//! process) per session and periodically polls liveness; when a PID vanishes,
//! it synthesizes a `session_end` event so the frontend removes the agent.

use crate::events::AgentEvent;
use std::collections::HashMap;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub type Tracker = Arc<Mutex<HashMap<String, u32>>>;

const DEFAULT_INTERVAL_SEC: u64 = 30;

pub fn new_tracker() -> Tracker {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Record that a session is alive under the given PID. Called on every
/// inbound event that carries a pid (covers SessionStart and every subsequent
/// hook, since Claude's PID is stable for the session).
pub fn note_alive(tracker: &Tracker, session_id: &str, pid: u32) {
    tracker.lock().unwrap().insert(session_id.to_string(), pid);
}

/// Remove a session from tracking — called on real `session_end` so the
/// reaper doesn't later synthesize a duplicate end.
pub fn note_gone(tracker: &Tracker, session_id: &str) {
    tracker.lock().unwrap().remove(session_id);
}

/// `kill -0 <pid>` returns 0 if the pid is alive (or the caller lacks
/// permission — still "exists"), non-zero if the pid is truly gone.
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    match Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
    {
        Ok(status) => status.success(),
        Err(_) => true, // couldn't probe — be conservative, assume alive
    }
}

/// Scan the tracker once, returning (session_id, pid) pairs whose PID is
/// gone. Extracted as a pure step so tests can drive the logic without
/// spinning up a Tauri AppHandle.
fn collect_dead<F: Fn(u32) -> bool>(tracker: &Tracker, is_alive: F) -> Vec<(String, u32)> {
    tracker
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, pid)| !is_alive(**pid))
        .map(|(s, p)| (s.clone(), *p))
        .collect()
}

/// Spawn a background thread that sweeps the tracker on a fixed interval and
/// emits synthetic `session_end` events for dead PIDs.
pub fn spawn(app: AppHandle, tracker: Tracker) {
    spawn_with_interval(app, tracker, DEFAULT_INTERVAL_SEC);
}

fn spawn_with_interval(app: AppHandle, tracker: Tracker, interval_sec: u64) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(interval_sec));
        sweep_once(&app, &tracker);
    });
}

fn sweep_once(app: &AppHandle, tracker: &Tracker) {
    let dead = collect_dead(tracker, pid_alive);
    for (session_id, pid) in dead {
        let ev = AgentEvent {
            session_id: session_id.clone(),
            source: "claude".to_string(),
            kind: "session_end".to_string(),
            tool: None,
            cwd: None,
            hook_event_name: Some("reaper".to_string()),
            ts_ms: AgentEvent::now_ms(),
            pid: Some(pid),
            message: None,
            command: None,
        };
        tracker.lock().unwrap().remove(&session_id);
        println!(
            "[pixel-agents reaper] session={} pid={} gone; synthesizing session_end",
            session_id, pid
        );
        if let Err(e) = app.emit("agent-event", &ev) {
            eprintln!("[pixel-agents reaper] emit failed: {}", e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pid_alive_current_process_is_alive() {
        let me = std::process::id();
        assert!(pid_alive(me));
    }

    #[test]
    fn pid_alive_zero_is_dead() {
        assert!(!pid_alive(0));
    }

    #[test]
    fn pid_alive_impossible_pid_is_dead() {
        // u32::MAX is not a realistic PID on any OS we target.
        assert!(!pid_alive(u32::MAX));
    }

    #[test]
    fn collect_dead_returns_only_dead_entries() {
        let tracker = new_tracker();
        note_alive(&tracker, "alive-session", 111);
        note_alive(&tracker, "dead-session", 222);
        note_alive(&tracker, "another-dead", 333);

        // Simulated liveness: only pid 111 is alive.
        let dead = collect_dead(&tracker, |pid| pid == 111);
        let mut sids: Vec<String> = dead.iter().map(|(s, _)| s.clone()).collect();
        sids.sort();
        assert_eq!(sids, vec!["another-dead", "dead-session"]);
    }

    #[test]
    fn note_gone_removes_from_tracker() {
        let tracker = new_tracker();
        note_alive(&tracker, "s1", 42);
        note_gone(&tracker, "s1");
        let dead = collect_dead(&tracker, |_| false);
        assert!(dead.is_empty(), "removed sessions shouldn't appear in sweep");
    }

    #[test]
    fn note_alive_overwrites_previous_pid() {
        let tracker = new_tracker();
        note_alive(&tracker, "s1", 10);
        note_alive(&tracker, "s1", 20);
        assert_eq!(tracker.lock().unwrap().get("s1"), Some(&20));
    }
}
