//! Silently install/update the hook-forwarder entries for each supported CLI
//! (`~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.grok/user-settings.json`)
//! on every app startup.
//!
//! We identify *our* entry in a CLI's settings file by looking for the shim
//! filename in the command string, so re-installs (app moved, dev vs. prod
//! build) rewrite the path in place instead of duplicating. Other users' hook
//! entries in the same file are preserved untouched. If a CLI's config dir
//! doesn't exist we skip it — we don't preemptively create another tool's
//! home directory.
//!
//! The command we write is the bare shim path (the shim has a
//! `#!/usr/bin/env python3` shebang). If a user has replaced it with an
//! explicit interpreter prefix like
//! `/opt/homebrew/opt/python@3.11/bin/python3.11 <shim-path>`, we treat that as
//! up-to-date so we don't clobber their edit — the idempotent check is "the
//! existing command already contains our current shim path".

use serde_json::{json, Map, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

/// One CLI's hook configuration layout.
struct HookTarget {
    /// Human-readable name, used only in log messages.
    cli_name: &'static str,
    /// Directory that must already exist for us to touch this CLI (we never
    /// create another tool's home dir).
    probe_dir: &'static str,
    /// Settings file to read/write, relative to `$HOME`.
    settings_file: &'static str,
    /// Resource path inside the Tauri bundle and filename used to identify
    /// our own hook entry across re-installs.
    shim_resource: &'static str,
    shim_marker: &'static str,
    /// `(event_name, needs_matcher)` — only Claude's tool-use hooks need the
    /// `matcher` field; Codex and Grok treat every hook uniformly.
    hook_events: &'static [(&'static str, bool)],
}

const CLAUDE_HOOK_EVENTS: &[(&str, bool)] = &[
    ("SessionStart", false),
    ("SessionEnd", false),
    ("PreToolUse", true),
    ("PostToolUse", true),
    ("Notification", false),
    ("Stop", false),
    ("SubagentStop", false),
];

// Codex has no Notification or SessionEnd hooks in its current schema.
// UserPromptSubmit fires at the start of each turn — we use it as a "wake up"
// cue so the pixel agent returns to its seat even if the turn produces no
// tool call.
const CODEX_HOOK_EVENTS: &[(&str, bool)] = &[
    ("SessionStart", false),
    ("UserPromptSubmit", false),
    ("PreToolUse", false),
    ("PostToolUse", false),
    ("Stop", false),
];

// Grok's hook event list is a superset of Claude's. The failure variants
// (PostToolUseFailure, StopFailure) collapse into their base kinds in the
// adapter, but we still register all of them so the app sees them.
const GROK_HOOK_EVENTS: &[(&str, bool)] = &[
    ("SessionStart", false),
    ("SessionEnd", false),
    ("PreToolUse", false),
    ("PostToolUse", false),
    ("PostToolUseFailure", false),
    ("Notification", false),
    ("Stop", false),
    ("StopFailure", false),
    ("SubagentStart", false),
    ("SubagentStop", false),
];

const HOOK_TARGETS: &[HookTarget] = &[
    HookTarget {
        cli_name: "Claude Code",
        probe_dir: ".claude",
        settings_file: ".claude/settings.json",
        shim_resource: "scripts/claude-hook-forward.py",
        shim_marker: "claude-hook-forward.py",
        hook_events: CLAUDE_HOOK_EVENTS,
    },
    HookTarget {
        cli_name: "Codex CLI",
        probe_dir: ".codex",
        settings_file: ".codex/hooks.json",
        shim_resource: "scripts/codex-hook-forward.py",
        shim_marker: "codex-hook-forward.py",
        hook_events: CODEX_HOOK_EVENTS,
    },
    HookTarget {
        cli_name: "Grok CLI",
        probe_dir: ".grok",
        settings_file: ".grok/user-settings.json",
        shim_resource: "scripts/grok-hook-forward.py",
        shim_marker: "grok-hook-forward.py",
        hook_events: GROK_HOOK_EVENTS,
    },
];

pub fn ensure_hooks_installed(app: &AppHandle) {
    for target in HOOK_TARGETS {
        if let Err(e) = install_one(app, target) {
            eprintln!("[pixel-agents installer] {}: {}", target.cli_name, e);
        }
    }
    ensure_codex_feature_enabled();
}

/// Codex hooks are gated behind `[features] codex_hooks = true` in
/// `~/.codex/config.toml`. Writing `hooks.json` alone won't fire events
/// if the feature flag is off — so without this the user sees "Codex
/// supported" in the UI but never a single event. Auto-append the flag
/// when missing, same idempotency rules as the hooks themselves: we only
/// touch the file if the current state is "feature not yet enabled".
fn ensure_codex_feature_enabled() {
    let Some(home) = dirs::home_dir() else { return };
    let cfg = home.join(".codex/config.toml");
    // If Codex isn't on the machine at all, install_one already skipped it.
    if !cfg.exists() {
        return;
    }
    let contents = match fs::read_to_string(&cfg) {
        Ok(s) => s,
        // Read errors (perms, transient) aren't fatal — stay quiet.
        Err(_) => return,
    };
    match codex_feature_state(&contents) {
        CodexFeatureState::Enabled => {}
        CodexFeatureState::ExplicitlyDisabled => {
            // User set `codex_hooks = false` on purpose — respect that
            // choice and warn instead of flipping their setting.
            eprintln!(
                "[pixel-agents installer] Codex CLI: `codex_hooks = false` in {} — \
                 leaving it alone. Set it to `true` to see Codex pixels.",
                cfg.display()
            );
        }
        state => {
            let new_contents = match state {
                CodexFeatureState::NoFeaturesSection => {
                    let sep = if contents.is_empty() || contents.ends_with('\n') {
                        ""
                    } else {
                        "\n"
                    };
                    format!("{}{}\n[features]\ncodex_hooks = true\n", contents, sep)
                }
                CodexFeatureState::FeaturesSectionMissingKey => {
                    insert_codex_hooks_under_features(&contents)
                }
                // The other two states are handled above.
                _ => unreachable!(),
            };
            if let Err(e) = fs::write(&cfg, &new_contents) {
                eprintln!(
                    "[pixel-agents installer] Codex CLI: failed to enable `codex_hooks` in {}: {}",
                    cfg.display(),
                    e
                );
                return;
            }
            println!(
                "[pixel-agents installer] Codex CLI: enabled `codex_hooks = true` in {}",
                cfg.display()
            );
        }
    }
}

/// Insert `codex_hooks = true` immediately under the existing `[features]`
/// header, preserving original formatting and leaving other keys alone.
fn insert_codex_hooks_under_features(toml: &str) -> String {
    let mut out = String::with_capacity(toml.len() + 32);
    let mut inserted = false;
    for line in toml.lines() {
        out.push_str(line);
        out.push('\n');
        if !inserted && line.trim_start_matches('[').trim_end_matches(']').trim() == "features"
            && line.trim().starts_with('[')
            && line.trim().ends_with(']')
        {
            out.push_str("codex_hooks = true\n");
            inserted = true;
        }
    }
    out
}

#[derive(Debug, PartialEq, Eq)]
enum CodexFeatureState {
    /// `[features] codex_hooks = true` already present — no-op.
    Enabled,
    /// `[features] codex_hooks = false` — user chose to disable, don't flip.
    ExplicitlyDisabled,
    /// `[features]` section exists but lacks a `codex_hooks` key — add it.
    FeaturesSectionMissingKey,
    /// File has no `[features]` section at all — append a fresh one.
    NoFeaturesSection,
}

/// Inspect a TOML blob for the `codex_hooks` flag under `[features]`.
/// Deliberately does not pull in a full TOML parser — this is a one-line
/// probe and the Codex config file is hand-edited by users.
fn codex_feature_state(toml: &str) -> CodexFeatureState {
    let mut in_features = false;
    let mut seen_features_section = false;
    for raw_line in toml.lines() {
        let line = raw_line.trim();
        // Skip blanks and full-line comments.
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Section headers reset the active table. `[features]` (with optional
        // surrounding whitespace inside the brackets) enables matching.
        if line.starts_with('[') && line.ends_with(']') {
            in_features = line.trim_start_matches('[').trim_end_matches(']').trim() == "features";
            if in_features {
                seen_features_section = true;
            }
            continue;
        }
        if !in_features {
            continue;
        }
        // Strip inline comments so `codex_hooks = true  # note` still matches.
        let code = line.split('#').next().unwrap_or("").trim();
        let Some((key, val)) = code.split_once('=') else {
            continue;
        };
        if key.trim() == "codex_hooks" {
            return match val.trim() {
                "true" => CodexFeatureState::Enabled,
                "false" => CodexFeatureState::ExplicitlyDisabled,
                // Non-boolean value — surface as missing so we append a
                // correct line; user can clean up the ambiguous one.
                _ => CodexFeatureState::FeaturesSectionMissingKey,
            };
        }
    }
    if seen_features_section {
        CodexFeatureState::FeaturesSectionMissingKey
    } else {
        CodexFeatureState::NoFeaturesSection
    }
}

fn install_one(app: &AppHandle, target: &HookTarget) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "cannot resolve home dir".to_string())?;
    let probe = home.join(target.probe_dir);
    if !probe.exists() {
        // This CLI isn't installed on the machine — don't create its config dir.
        return Ok(());
    }

    let shim_path = resolve_shim_path(app, target.shim_resource)?;
    make_executable(&shim_path);

    let settings_path = home.join(target.settings_file);
    let mut root = read_settings(&settings_path)?;
    let changed = merge_hook_entries(&mut root, &shim_path, target);
    if changed {
        write_settings_atomic(&settings_path, &root)?;
        println!(
            "[pixel-agents installer] {}: updated {} with hook shim at {}",
            target.cli_name,
            settings_path.display(),
            shim_path.display()
        );
    }
    Ok(())
}

fn resolve_shim_path(app: &AppHandle, resource: &str) -> Result<PathBuf, String> {
    // Prefer the project source tree when it exists — that's the canonical
    // path in dev builds. In production the source dir won't exist on the
    // user's machine, and we fall through to the bundled resource. Picking
    // source-first matters because dev rebuilds shuffle the `target/debug/`
    // copy's mtime; if the installer migrated hook commands to that path,
    // every `cargo watch` rebuild would rewrite the user's config.
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dev = manifest_dir.join("..").join(resource);
    if dev.exists() {
        return dev
            .canonicalize()
            .map_err(|e| format!("canonicalize dev shim: {}", e));
    }
    if let Ok(p) = app.path().resolve(resource, BaseDirectory::Resource) {
        if p.exists() {
            return Ok(p);
        }
    }
    Err(format!(
        "shim script {} not found (checked source tree and resource dir)",
        resource
    ))
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = fs::metadata(path) {
        let mut perms = meta.permissions();
        let mode = perms.mode();
        if mode & 0o111 != 0o111 {
            perms.set_mode(mode | 0o755);
            let _ = fs::set_permissions(path, perms);
        }
    }
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {}

fn read_settings(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(Value::Object(Map::new()));
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    if raw.trim().is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_str(&raw).map_err(|e| {
        format!(
            "parse {} — leaving file untouched: {}",
            path.display(),
            e
        )
    })
}

/// Returns true if any edits were made.
fn merge_hook_entries(root: &mut Value, shim_path: &Path, target: &HookTarget) -> bool {
    let shim_str = shim_path.to_string_lossy().to_string();
    let root_obj = match root {
        Value::Object(m) => m,
        _ => return false,
    };
    let hooks = root_obj
        .entry("hooks".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let hooks_obj = match hooks {
        Value::Object(m) => m,
        _ => return false,
    };

    let mut changed = false;
    for (event, needs_matcher) in target.hook_events {
        let entry_array = hooks_obj
            .entry(event.to_string())
            .or_insert_with(|| Value::Array(vec![]));
        let arr = match entry_array {
            Value::Array(a) => a,
            _ => continue,
        };
        if update_or_append(arr, &shim_str, target.shim_marker, *needs_matcher) {
            changed = true;
        }
    }
    changed
}

/// Within one hook-event array (e.g. `hooks.PreToolUse`), ensure there is a
/// block containing our shim command. Returns true if the array was modified.
///
/// Idempotency rule: if an existing block's command *contains* the current
/// shim path verbatim, we leave it alone. This preserves user-authored
/// interpreter prefixes like `/opt/homebrew/opt/python@3.11/bin/python3.11
/// <shim-path>`.
fn update_or_append(
    arr: &mut Vec<Value>,
    shim_path: &str,
    shim_marker: &str,
    needs_matcher: bool,
) -> bool {
    // 1) Search for an existing block with a command containing our marker.
    for block in arr.iter_mut() {
        let Some(block_obj) = block.as_object_mut() else {
            continue;
        };
        let Some(block_hooks) = block_obj.get_mut("hooks").and_then(Value::as_array_mut) else {
            continue;
        };
        for hook in block_hooks.iter_mut() {
            let Some(hook_obj) = hook.as_object_mut() else {
                continue;
            };
            let Some(cmd) = hook_obj.get("command").and_then(Value::as_str) else {
                continue;
            };
            if cmd.contains(shim_marker) {
                // User's command already points at the current shim (possibly
                // with an interpreter prefix they added). No-op.
                if cmd.contains(shim_path) {
                    return false;
                }
                hook_obj.insert("command".to_string(), Value::String(shim_path.to_string()));
                return true;
            }
        }
    }

    // 2) No match — append a new block.
    let mut block = Map::new();
    if needs_matcher {
        block.insert("matcher".to_string(), Value::String("*".to_string()));
    }
    block.insert(
        "hooks".to_string(),
        json!([{ "type": "command", "command": shim_path }]),
    );
    arr.push(Value::Object(block));
    true
}

fn write_settings_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let pretty = serde_json::to_string_pretty(value)
        .map_err(|e| format!("serialize: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = fs::File::create(&tmp)
            .map_err(|e| format!("create {}: {}", tmp.display(), e))?;
        f.write_all(pretty.as_bytes())
            .map_err(|e| format!("write {}: {}", tmp.display(), e))?;
        f.write_all(b"\n").ok();
    }
    fs::rename(&tmp, path).map_err(|e| format!("rename {}: {}", path.display(), e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE: &HookTarget = &HOOK_TARGETS[0];
    const CODEX: &HookTarget = &HOOK_TARGETS[1];
    const GROK: &HookTarget = &HOOK_TARGETS[2];

    fn shim(name: &str) -> String {
        format!("/opt/pixel-agents.app/Contents/Resources/scripts/{}", name)
    }

    fn claude_shim() -> String {
        shim("claude-hook-forward.py")
    }
    fn codex_shim() -> String {
        shim("codex-hook-forward.py")
    }
    fn grok_shim() -> String {
        shim("grok-hook-forward.py")
    }

    #[test]
    fn claude_inserts_into_empty_settings() {
        let mut root = json!({});
        assert!(merge_hook_entries(&mut root, Path::new(&claude_shim()), CLAUDE));
        let hooks = root.get("hooks").unwrap().as_object().unwrap();
        for (event, needs_matcher) in CLAUDE.hook_events {
            let arr = hooks.get(*event).unwrap().as_array().unwrap();
            assert_eq!(arr.len(), 1, "{}", event);
            let block = arr[0].as_object().unwrap();
            assert_eq!(block.contains_key("matcher"), *needs_matcher, "{}", event);
            let cmd = block["hooks"][0]["command"].as_str().unwrap();
            assert_eq!(cmd, claude_shim());
        }
    }

    #[test]
    fn codex_inserts_without_matcher() {
        let mut root = json!({});
        assert!(merge_hook_entries(&mut root, Path::new(&codex_shim()), CODEX));
        let hooks = root.get("hooks").unwrap().as_object().unwrap();
        // Codex has its own event list — Notification / SessionEnd are absent,
        // UserPromptSubmit is present.
        assert!(hooks.contains_key("UserPromptSubmit"));
        assert!(!hooks.contains_key("Notification"));
        for (event, _) in CODEX.hook_events {
            let arr = hooks.get(*event).unwrap().as_array().unwrap();
            assert_eq!(arr.len(), 1);
            // No Codex event uses matcher.
            assert!(arr[0].as_object().unwrap().get("matcher").is_none(), "{}", event);
        }
    }

    #[test]
    fn grok_inserts_failure_variants() {
        let mut root = json!({});
        assert!(merge_hook_entries(&mut root, Path::new(&grok_shim()), GROK));
        let hooks = root.get("hooks").unwrap().as_object().unwrap();
        assert!(hooks.contains_key("PostToolUseFailure"));
        assert!(hooks.contains_key("StopFailure"));
        assert!(hooks.contains_key("SubagentStart"));
    }

    #[test]
    fn idempotent_on_rerun() {
        let mut root = json!({});
        let shim_p = claude_shim();
        assert!(merge_hook_entries(&mut root, Path::new(&shim_p), CLAUDE));
        assert!(
            !merge_hook_entries(&mut root, Path::new(&shim_p), CLAUDE),
            "second merge should be a no-op"
        );
    }

    #[test]
    fn updates_stale_path_in_place() {
        let mut root = json!({
            "hooks": {
                "Stop": [
                    { "hooks": [
                        { "type": "command", "command": "/old/path/claude-hook-forward.py" }
                    ]}
                ]
            }
        });
        let changed = merge_hook_entries(&mut root, Path::new(&claude_shim()), CLAUDE);
        assert!(changed);
        let arr = root["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(arr.len(), 1, "should update in place, not duplicate");
        assert_eq!(arr[0]["hooks"][0]["command"], claude_shim());
    }

    #[test]
    fn preserves_interpreter_prefix() {
        // User manually prefixed an explicit Python interpreter. The shim path
        // still points at the current location, so we must leave it alone.
        let current_shim = claude_shim();
        let user_cmd = format!("/opt/homebrew/bin/python3.11 {}", current_shim);
        let mut root = json!({
            "hooks": {
                "Stop": [
                    { "hooks": [
                        { "type": "command", "command": user_cmd }
                    ]}
                ]
            }
        });
        let changed = merge_hook_entries(&mut root, Path::new(&current_shim), CLAUDE);
        // merge still returns true because other Claude events need to be added,
        // but the Stop block must be preserved verbatim.
        let _ = changed;
        let stop_cmd = root["hooks"]["Stop"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert!(
            stop_cmd.starts_with("/opt/homebrew/bin/python3.11 "),
            "interpreter prefix must be preserved, got: {}",
            stop_cmd
        );
    }

    #[test]
    fn preserves_unrelated_user_entries() {
        let mut root = json!({
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Bash", "hooks": [
                        { "type": "command", "command": "/users/me/my-other-hook.sh" }
                    ]}
                ]
            },
            "other_user_config": { "theme": "dark" }
        });
        merge_hook_entries(&mut root, Path::new(&claude_shim()), CLAUDE);
        let arr = root["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(arr.len(), 2, "appended alongside user's entry");
        assert_eq!(arr[0]["hooks"][0]["command"], "/users/me/my-other-hook.sh");
        assert_eq!(
            root["other_user_config"]["theme"], "dark",
            "top-level user keys must be preserved"
        );
    }

    #[test]
    fn grok_preserves_apikey() {
        // Grok stores its API key in the same settings file as hooks — losing
        // it on install would be catastrophic.
        let mut root = json!({
            "apiKey": "xai-secret",
            "defaultModel": "grok-4"
        });
        merge_hook_entries(&mut root, Path::new(&grok_shim()), GROK);
        assert_eq!(root["apiKey"], "xai-secret");
        assert_eq!(root["defaultModel"], "grok-4");
        assert!(root["hooks"].is_object());
    }

    #[test]
    fn does_not_add_matcher_to_non_tool_events() {
        let mut root = json!({});
        merge_hook_entries(&mut root, Path::new(&claude_shim()), CLAUDE);
        let block = &root["hooks"]["SessionStart"][0];
        assert!(block.get("matcher").is_none());
    }

    #[test]
    fn codex_feature_detected_when_enabled() {
        let toml = "[features]\ncodex_hooks = true\n";
        assert_eq!(codex_feature_state(toml), CodexFeatureState::Enabled);
    }

    #[test]
    fn codex_feature_detected_with_whitespace_and_comment() {
        let toml = "# some header comment\n\n[features]\n  codex_hooks  =  true   # enable hooks\n";
        assert_eq!(codex_feature_state(toml), CodexFeatureState::Enabled);
    }

    #[test]
    fn codex_feature_explicit_false_is_preserved() {
        let toml = "[features]\ncodex_hooks = false\n";
        assert_eq!(
            codex_feature_state(toml),
            CodexFeatureState::ExplicitlyDisabled
        );
    }

    #[test]
    fn codex_feature_no_features_section_means_no_features_section() {
        let toml = "model = \"gpt-5\"\n[model_providers.azure]\nname = \"Azure\"\n";
        assert_eq!(codex_feature_state(toml), CodexFeatureState::NoFeaturesSection);
    }

    #[test]
    fn codex_feature_key_in_wrong_section_does_not_count() {
        // `codex_hooks = true` under some other section doesn't count; the
        // `[features]` block itself exists but lacks the key.
        let toml = "[experimental]\ncodex_hooks = true\n[features]\nother_flag = true\n";
        assert_eq!(
            codex_feature_state(toml),
            CodexFeatureState::FeaturesSectionMissingKey
        );
    }

    #[test]
    fn codex_feature_detected_after_reentering_features() {
        // A later `[features]` block with the flag should still count even if
        // an earlier section disabled it.
        let toml = "[features]\nother = false\n[model_providers.azure]\nname = \"x\"\n[features]\ncodex_hooks = true\n";
        assert_eq!(codex_feature_state(toml), CodexFeatureState::Enabled);
    }

    #[test]
    fn appends_new_features_section_when_absent() {
        let toml = "model = \"gpt-5\"\n";
        // The actual file write is mocked via the state check; verify the
        // composition logic produces something the probe now recognises.
        let sep = if toml.ends_with('\n') { "" } else { "\n" };
        let appended = format!("{}{}\n[features]\ncodex_hooks = true\n", toml, sep);
        assert_eq!(codex_feature_state(&appended), CodexFeatureState::Enabled);
    }

    #[test]
    fn inserts_key_into_existing_features_section() {
        let toml = "[features]\nother_flag = true\n[model_providers.azure]\nname = \"x\"\n";
        let patched = insert_codex_hooks_under_features(toml);
        assert_eq!(codex_feature_state(&patched), CodexFeatureState::Enabled);
        // Unrelated keys preserved
        assert!(patched.contains("other_flag = true"));
        assert!(patched.contains("[model_providers.azure]"));
    }
}
