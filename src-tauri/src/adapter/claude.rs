use crate::events::AgentEvent;
use serde_json::Value;

/// Translate a Claude Code hook payload into a unified AgentEvent.
///
/// Claude Code hooks send JSON on stdin with shape:
/// {
///   "session_id": "abc123",
///   "hook_event_name": "PreToolUse" | "PostToolUse" | "Notification"
///                    | "Stop" | "SessionStart" | "SessionEnd" | "SubagentStop",
///   "tool_name": "Edit",          // PreToolUse / PostToolUse
///   "tool_input": { ... },
///   "cwd": "/path/to/workspace"   // optional
/// }
pub fn normalize(raw: &Value) -> Option<AgentEvent> {
    let session_id = raw.get("session_id").and_then(Value::as_str)?.to_string();
    let hook_event_name = raw
        .get("hook_event_name")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    let tool = raw
        .get("tool_name")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    let cwd = raw
        .get("cwd")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    let pid = raw.get("pid").and_then(Value::as_u64).map(|p| p as u32);
    // Claude Notification hooks include a `message` field; carry it through
    // so the webview can tell "permission required" from "idle reminder".
    let message = raw
        .get("message")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    // PreToolUse(Bash).tool_input.command — lets the webview spot `rm …`
    // patterns and route the agent to the trash bin for a visual cue.
    let command = raw
        .get("tool_input")
        .and_then(|ti| ti.get("command"))
        .and_then(Value::as_str)
        .map(|s| s.to_string());

    let kind = match hook_event_name.as_deref() {
        Some("SessionStart") => "session_start",
        Some("SessionEnd") => "session_end",
        Some("PreToolUse") => "pre_tool_use",
        Some("PostToolUse") => "post_tool_use",
        Some("Notification") => "notification",
        Some("Stop") => "stop",
        Some("SubagentStop") => "sub_agent_stop",
        _ => return None,
    }
    .to_string();

    Some(AgentEvent {
        session_id,
        source: "claude".to_string(),
        kind,
        tool,
        cwd,
        hook_event_name,
        ts_ms: AgentEvent::now_ms(),
        pid,
        message,
        command,
    })
}
