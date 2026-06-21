//! Keyboard synthesis uses the cross-platform `enigo` crate on every platform.
//!
//! Each press HOLDS the key down for [`KEY_HOLD`] before releasing it, rather
//! than tapping it instantly. Emulators sample input once per rendered frame
//! during gameplay (DirectInput `GetDeviceState`, SDL polling, etc.); a key that
//! is pressed and released in the same instant falls between two polls and is
//! never observed as down — which is why inputs only registered when mashed, and
//! not at all in some games. A hold spanning several frames is sampled reliably.
//! (Binding/calibration screens listen for discrete key *events*, so they caught
//! even the instant taps — hence those always worked.)

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::time::Duration;

/// How long a synthesized key is held down before release. ~80ms is ≈5 frames at
/// 60fps (and ≥2 at 30fps), enough for an emulator's per-frame input poll to
/// reliably sample it. Bump this if a particular emulator still misses inputs;
/// lower it if rapid repeated taps merge.
const KEY_HOLD: Duration = Duration::from_millis(80);

/// Tap a key — press, hold for [`KEY_HOLD`], release — at the OS level, holding
/// any modifiers down for the duration. `code` is a browser `KeyboardEvent.code`;
/// `modifiers` are names like "Shift"/"Control"/"Alt"/"Meta" from the capture UI.
///
/// Runs on a blocking worker thread (via `spawn_blocking`) so the [`KEY_HOLD`]
/// sleep never stalls the UI thread when many players tap at once.
#[tauri::command]
async fn press_key(code: String, modifiers: Vec<String>) -> Result<(), String> {
    match tauri::async_runtime::spawn_blocking(move || press(&code, &modifiers)).await {
        Ok(res) => res,
        Err(e) => Err(e.to_string()),
    }
}

/// Map a printable `KeyboardEvent.code` to its macOS virtual keycode (ANSI
/// layout). On macOS, synthesizing a `Key::Unicode(c)` makes enigo resolve the
/// character through the Carbon Text Input Source Manager, whose APIs assert they
/// are called on the main thread and abort the process otherwise (SIGTRAP). We
/// run key presses on a `spawn_blocking` worker thread, so that assertion fires
/// on the first letter/digit/punctuation press. Pressing `Key::Other(vk)` with a
/// raw keycode bypasses that lookup. Mapping by physical `code` is also more
/// correct for games (position-based, layout-independent).
#[cfg(target_os = "macos")]
fn macos_virtual_keycode(code: &str) -> Option<u32> {
    Some(match code {
        "KeyA" => 0x00, "KeyS" => 0x01, "KeyD" => 0x02, "KeyF" => 0x03,
        "KeyH" => 0x04, "KeyG" => 0x05, "KeyZ" => 0x06, "KeyX" => 0x07,
        "KeyC" => 0x08, "KeyV" => 0x09, "KeyB" => 0x0B, "KeyQ" => 0x0C,
        "KeyW" => 0x0D, "KeyE" => 0x0E, "KeyR" => 0x0F, "KeyY" => 0x10,
        "KeyT" => 0x11, "KeyO" => 0x1F, "KeyU" => 0x20, "KeyI" => 0x22,
        "KeyP" => 0x23, "KeyL" => 0x25, "KeyJ" => 0x26, "KeyK" => 0x28,
        "KeyN" => 0x2D, "KeyM" => 0x2E,
        "Digit1" => 0x12, "Digit2" => 0x13, "Digit3" => 0x14, "Digit4" => 0x15,
        "Digit6" => 0x16, "Digit5" => 0x17, "Digit9" => 0x19, "Digit7" => 0x1A,
        "Digit8" => 0x1C, "Digit0" => 0x1D,
        "Numpad0" => 0x52, "Numpad1" => 0x53, "Numpad2" => 0x54, "Numpad3" => 0x55,
        "Numpad4" => 0x56, "Numpad5" => 0x57, "Numpad6" => 0x58, "Numpad7" => 0x59,
        "Numpad8" => 0x5B, "Numpad9" => 0x5C,
        "Minus" => 0x1B, "Equal" => 0x18, "BracketLeft" => 0x21,
        "BracketRight" => 0x1E, "Backslash" => 0x2A, "Semicolon" => 0x29,
        "Quote" => 0x27, "Comma" => 0x2B, "Period" => 0x2F, "Slash" => 0x2C,
        "Backquote" => 0x32,
        _ => return None,
    })
}

/// Map a browser `KeyboardEvent.code` to an enigo key. Using `code` (physical
/// key) rather than `key` (produced character) keeps WASD/arrows/etc. working
/// regardless of layout and matches what games typically read.
fn code_to_key(code: &str) -> Option<Key> {
    // On macOS, route printable keys to raw virtual keycodes to avoid the
    // main-thread-only Text Input Source lookup (see `macos_virtual_keycode`).
    #[cfg(target_os = "macos")]
    if let Some(vk) = macos_virtual_keycode(code) {
        return Some(Key::Other(vk));
    }

    // Letters: "KeyA" -> 'a'
    if let Some(letter) = code.strip_prefix("Key") {
        let c = letter.chars().next()?;
        return Some(Key::Unicode(c.to_ascii_lowercase()));
    }
    // Top-row digits: "Digit1" -> '1'
    if let Some(digit) = code.strip_prefix("Digit") {
        let c = digit.chars().next()?;
        return Some(Key::Unicode(c));
    }
    // Numpad digits: "Numpad1" -> '1'
    if let Some(digit) = code.strip_prefix("Numpad") {
        let c = digit.chars().next()?;
        if c.is_ascii_digit() {
            return Some(Key::Unicode(c));
        }
    }
    // Function keys: "F1".."F12"
    if let Some(n) = code.strip_prefix('F') {
        if let Ok(num) = n.parse::<u8>() {
            return match num {
                1 => Some(Key::F1),
                2 => Some(Key::F2),
                3 => Some(Key::F3),
                4 => Some(Key::F4),
                5 => Some(Key::F5),
                6 => Some(Key::F6),
                7 => Some(Key::F7),
                8 => Some(Key::F8),
                9 => Some(Key::F9),
                10 => Some(Key::F10),
                11 => Some(Key::F11),
                12 => Some(Key::F12),
                _ => None,
            };
        }
    }

    Some(match code {
        "Space" => Key::Space,
        "Enter" | "NumpadEnter" => Key::Return,
        "Tab" => Key::Tab,
        "Backspace" => Key::Backspace,
        "Escape" => Key::Escape,
        "ArrowUp" => Key::UpArrow,
        "ArrowDown" => Key::DownArrow,
        "ArrowLeft" => Key::LeftArrow,
        "ArrowRight" => Key::RightArrow,
        "ShiftLeft" | "ShiftRight" => Key::Shift,
        "ControlLeft" | "ControlRight" => Key::Control,
        "AltLeft" | "AltRight" => Key::Alt,
        "MetaLeft" | "MetaRight" => Key::Meta,
        "Minus" => Key::Unicode('-'),
        "Equal" => Key::Unicode('='),
        "BracketLeft" => Key::Unicode('['),
        "BracketRight" => Key::Unicode(']'),
        "Backslash" => Key::Unicode('\\'),
        "Semicolon" => Key::Unicode(';'),
        "Quote" => Key::Unicode('\''),
        "Comma" => Key::Unicode(','),
        "Period" => Key::Unicode('.'),
        "Slash" => Key::Unicode('/'),
        "Backquote" => Key::Unicode('`'),
        _ => return None,
    })
}

/// Map a modifier name from the frontend to its enigo key.
fn modifier_to_key(name: &str) -> Option<Key> {
    Some(match name {
        "Control" => Key::Control,
        "Alt" => Key::Alt,
        "Shift" => Key::Shift,
        "Meta" => Key::Meta,
        _ => return None,
    })
}

fn press(code: &str, modifiers: &[String]) -> Result<(), String> {
    let key = code_to_key(code).ok_or_else(|| format!("Unsupported key: {code}"))?;
    let mods: Vec<Key> = modifiers.iter().filter_map(|m| modifier_to_key(m)).collect();

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    for m in &mods {
        enigo.key(*m, Direction::Press).map_err(|e| e.to_string())?;
    }

    // Hold the key down for KEY_HOLD (see module docs) so per-frame input polls
    // sample it, rather than tapping it instantly with Direction::Click.
    let pressed = enigo.key(key, Direction::Press);
    if pressed.is_ok() {
        std::thread::sleep(KEY_HOLD);
    }
    let released = enigo.key(key, Direction::Release);

    // Always release modifiers, even if the key press/release failed, so we don't
    // leave a modifier stuck down at the OS level.
    for m in mods.iter().rev() {
        let _ = enigo.key(*m, Direction::Release);
    }

    pressed.map_err(|e| e.to_string())?;
    released.map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    // Auto-updater is desktop-only; `process` backs the post-install relaunch.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
        .invoke_handler(tauri::generate_handler![press_key])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
