use crate::events::AgentEvent;
use serde_json::Value;

/// Map Grok's built-in tool names to Claude canonical names so the
/// downstream verb table and library/seat routing work without changes.
/// Unknown tools pass through verbatim and render as the generic "working"
/// verb — extend this table as new Grok tools show up in traces.
fn normalize_tool(name: &str) -> &str {
    match name {
        "bash" | "shell" | "execute_bash" | "run_command" => "Bash",
        "str_replace_editor" | "edit_file" | "edit" | "apply_patch" => "Edit",
        "create_file" | "write_file" | "new_file" => "Write",
        "view_file" | "read_file" | "view" => "Read",
        "grep_search" | "search_files" | "grep" => "Grep",
        "glob_files" | "find_files" | "glob" => "Glob",
        "web_search" | "browse" => "WebSearch",
        "web_fetch" | "fetch" | "url_fetch" => "WebFetch",
        "delegate" | "spawn_agent" => "Task",
        other => other,
    }
}

/// Translate a Grok CLI hook payload into a unified AgentEvent.
///
/// Grok hooks (configured at `~/.grok/user-settings.json`) cover a superset
/// of Claude's event names; we map the overlap and fold the rest into existing
/// kinds so the pixel agent doesn't grow new behavior branches:
///   - `PostToolUseFailure` → post_tool_use (visual doesn't distinguish failure)
///   - `StopFailure`        → stop
///   - `SubagentStart/Stop` → sub_agent_stop
///   - `TaskCreated/Completed`, `PreCompact/PostCompact`,
///     `InstructionsLoaded`, `CwdChanged` → ignored (no pixel affordance yet)
pub fn normalize(raw: &Value) -> Option<AgentEvent> {
    // Grok occasionally fires hooks (UserPromptSubmit / early SessionStart)
    // before its internal `session` object is initialized — `session_id`
    // then serializes as `undefined` and JSON.stringify drops the field,
    // leaving the rest of the payload valid. Fall back to a pid-scoped id
    // so every hook from the same Grok process lands on the same pixel
    // character instead of being silently discarded upstream.
    let session_id = raw
        .get("session_id")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .or_else(|| {
            raw.get("pid")
                .and_then(Value::as_u64)
                .map(|p| format!("grok-pid-{}", p))
        })?;
    let hook_event_name = raw
        .get("hook_event_name")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    let tool = raw
        .get("tool_name")
        .and_then(Value::as_str)
        .map(normalize_tool)
        .map(|s| s.to_string());
    let cwd = raw
        .get("cwd")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    let pid = raw.get("pid").and_then(Value::as_u64).map(|p| p as u32);
    let message = raw
        .get("message")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    let command = raw
        .get("tool_input")
        .and_then(|ti| ti.get("command"))
        .and_then(Value::as_str)
        .map(|s| s.to_string());

    let kind = match hook_event_name.as_deref() {
        Some("SessionStart") => "session_start",
        Some("SessionEnd") => "session_end",
        Some("PreToolUse") => "pre_tool_use",
        Some("PostToolUse") | Some("PostToolUseFailure") => "post_tool_use",
        Some("Notification") => "notification",
        Some("UserPromptSubmit") => "pre_tool_use",
        Some("Stop") | Some("StopFailure") => "stop",
        Some("SubagentStart") | Some("SubagentStop") => "sub_agent_stop",
        // Silently drop events with no current visual mapping.
        _ => return None,
    }
    .to_string();

    Some(AgentEvent {
        session_id,
        source: "grok".to_string(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_session_id_falls_back_to_pid() {
        // Reproduces the real Grok bug: hook fires before session init, so
        // the serialized payload has no session_id field. We synthesize one
        // from pid instead of dropping the event.
        let raw = json!({
            "hook_event_name": "PreToolUse",
            "cwd": "/tmp",
            "tool_name": "bash",
            "pid": 42,
        });
        let ev = normalize(&raw).expect("should not drop on missing session_id");
        assert_eq!(ev.session_id, "grok-pid-42");
        assert_eq!(ev.kind, "pre_tool_use");
        assert_eq!(ev.tool.as_deref(), Some("Bash"));
    }

    #[test]
    fn missing_session_id_and_pid_still_drops() {
        // No way to route the event — give up cleanly rather than invent
        // a constant session id that would collide with itself.
        let raw = json!({
            "hook_event_name": "PreToolUse",
            "cwd": "/tmp",
        });
        assert!(normalize(&raw).is_none());
    }

    #[test]
    fn real_session_id_takes_precedence_over_pid() {
        let raw = json!({
            "hook_event_name": "Stop",
            "session_id": "abc123",
            "pid": 99,
        });
        let ev = normalize(&raw).unwrap();
        assert_eq!(ev.session_id, "abc123");
    }
}
