use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

/// Unified event emitted from any CLI agent adapter (Claude Code, Codex, Trae, ...)
/// toward the webview. Frontend maps `kind` → OfficeState action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEvent {
    /// Unique per-session agent id (stable for the lifetime of a CLI session)
    pub session_id: String,
    /// Agent kind: "claude" | "codex" | "trae" | "grok" | ...
    pub source: String,
    /// Normalized kind: "session_start" | "pre_tool_use" | "post_tool_use"
    ///                 | "notification" | "stop" | "session_end" | "sub_agent"
    pub kind: String,
    /// Tool name (Edit, Write, Bash, Read, Grep, WebFetch, Task, ...) if known
    pub tool: Option<String>,
    /// Workspace cwd if provided by the hook
    pub cwd: Option<String>,
    /// Original hook_event_name from source adapter (diagnostics)
    pub hook_event_name: Option<String>,
    /// Unix epoch millis when the adapter received the event
    pub ts_ms: u64,
    /// Parent process PID of the adapter shim at hook invocation time.
    /// For Claude Code, this is the Claude process; the reaper polls it to
    /// detect crashes/SIGKILLs that never produce a SessionEnd.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// Free-form message from the source adapter. For Claude `Notification`
    /// hooks this distinguishes "needs permission" from "idle waiting for input".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// For PreToolUse(Bash) events, the shell command string from
    /// `tool_input.command`. Lets the frontend detect patterns like `rm …`
    /// to route the agent to furniture cues (the bin in this case).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

impl AgentEvent {
    pub fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}
