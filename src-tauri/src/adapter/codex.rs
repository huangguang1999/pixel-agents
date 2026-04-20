use crate::events::AgentEvent;
use serde_json::Value;

/// Map Codex's built-in tool names to Claude canonical names so the
/// downstream verb table and library/seat routing work without changes.
/// Unknown tools (MCP-provided, plugins) pass through verbatim and will
/// render with the generic "working" verb.
fn normalize_tool(name: &str) -> &str {
    match name {
        "shell" | "local_shell" | "unified_exec" | "execute" => "Bash",
        "apply_patch" | "edit_file" | "edit" | "str_replace" => "Edit",
        "write_file" | "create_file" => "Write",
        "read_file" | "view_file" | "view" => "Read",
        "grep" | "grep_search" | "search" => "Grep",
        "glob" | "glob_files" | "find_files" => "Glob",
        "web_search" => "WebSearch",
        "web_fetch" | "fetch" => "WebFetch",
        "update_plan" | "delegate" => "Task",
        other => other,
    }
}

/// Translate an OpenAI Codex CLI hook payload into a unified AgentEvent.
///
/// Codex hooks (discovered at `~/.codex/hooks.json`, enabled via
/// `config.toml` `[features] codex_hooks = true`) dispatch:
/// SessionStart / PreToolUse / PostToolUse / UserPromptSubmit / Stop
///
/// The stdin JSON shape mirrors Claude's but adds `model`, `turn_id`,
/// and a `SessionStart.source` of "startup" | "resume". No Notification
/// event and no SessionEnd — we rely on the reaper for the latter.
pub fn normalize(raw: &Value) -> Option<AgentEvent> {
    let session_id = raw.get("session_id").and_then(Value::as_str)?.to_string();
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
    let command = raw
        .get("tool_input")
        .and_then(|ti| ti.get("command"))
        .and_then(Value::as_str)
        .map(|s| s.to_string());

    let kind = match hook_event_name.as_deref() {
        Some("SessionStart") => "session_start",
        Some("PreToolUse") => "pre_tool_use",
        Some("PostToolUse") => "post_tool_use",
        // UserPromptSubmit marks the start of a fresh turn — treat as a
        // "wake up and go back to seat" cue. pre_tool_use cues follow
        // right after, so this only matters when the turn produces no tool call.
        Some("UserPromptSubmit") => "pre_tool_use",
        Some("Stop") => "stop",
        _ => return None,
    }
    .to_string();

    Some(AgentEvent {
        session_id,
        source: "codex".to_string(),
        kind,
        tool,
        cwd,
        hook_event_name,
        ts_ms: AgentEvent::now_ms(),
        pid,
        // Codex has no Notification hook — permission/waiting visuals don't fire.
        message: None,
        command,
    })
}
