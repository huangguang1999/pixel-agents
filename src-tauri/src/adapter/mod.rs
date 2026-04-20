pub mod claude;
pub mod codex;
pub mod grok;

use crate::events::AgentEvent;
use serde_json::Value;

/// Dispatch a raw hook payload to the matching per-CLI adapter.
///
/// The shim script for each CLI injects a top-level `source` field
/// ("claude" | "codex" | "grok") before forwarding to the UDS, so we
/// switch on that. When absent (older shim or hand-crafted payload),
/// we fall back to claude for backward compatibility — all three CLIs
/// share Claude's `hook_event_name` field naming.
pub fn normalize(raw: &Value) -> Option<AgentEvent> {
    match raw.get("source").and_then(Value::as_str) {
        Some("codex") => codex::normalize(raw),
        Some("grok") => grok::normalize(raw),
        Some("claude") => claude::normalize(raw),
        _ if raw.get("hook_event_name").and_then(Value::as_str).is_some() => {
            claude::normalize(raw)
        }
        _ => None,
    }
}
