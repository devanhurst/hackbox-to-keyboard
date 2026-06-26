use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::time::Duration;

const KEY_HOLD: Duration = Duration::from_millis(80);

#[tauri::command]
async fn press_key(code: String, modifiers: Vec<String>) -> Result<(), String> {
    match tauri::async_runtime::spawn_blocking(move || press(&code, &modifiers)).await {
        Ok(res) => res,
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn accessibility_trusted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn accessibility_trusted() -> bool {
    true
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn open_accessibility_settings() {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn();
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn open_accessibility_settings() {}

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
        // Modifier keys as standalone press targets — true left/right via the
        // raw virtual keycodes (Apple Events.h), since enigo's generic
        // Key::Shift/Control/Alt/Meta collapse both sides into one.
        "MetaLeft" => 0x37, "MetaRight" => 0x36,
        "ShiftLeft" => 0x38, "ShiftRight" => 0x3C,
        "AltLeft" => 0x3A, "AltRight" => 0x3D,
        "ControlLeft" => 0x3B, "ControlRight" => 0x3E,
        _ => return None,
    })
}

// Windows side-specific virtual-key codes for standalone modifier presses, so
// Left/Right map to distinct physical keys instead of enigo's generic modifier.
// Verify on a real Windows build: if Key::Other does not distinguish sides, the
// generic Key::Shift/Control/Alt/Meta arms in code_to_key remain a working
// fallback.
#[cfg(target_os = "windows")]
fn windows_virtual_keycode(code: &str) -> Option<u32> {
    Some(match code {
        "ShiftLeft" => 0xA0, "ShiftRight" => 0xA1,
        "ControlLeft" => 0xA2, "ControlRight" => 0xA3,
        "AltLeft" => 0xA4, "AltRight" => 0xA5,
        "MetaLeft" => 0x5B, "MetaRight" => 0x5C,
        _ => return None,
    })
}

fn code_to_key(code: &str) -> Option<Key> {
    #[cfg(target_os = "macos")]
    if let Some(vk) = macos_virtual_keycode(code) {
        return Some(Key::Other(vk));
    }

    #[cfg(target_os = "windows")]
    if let Some(vk) = windows_virtual_keycode(code) {
        return Some(Key::Other(vk));
    }

    if let Some(letter) = code.strip_prefix("Key") {
        let c = letter.chars().next()?;
        return Some(Key::Unicode(c.to_ascii_lowercase()));
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        let c = digit.chars().next()?;
        return Some(Key::Unicode(c));
    }
    if let Some(digit) = code.strip_prefix("Numpad") {
        let c = digit.chars().next()?;
        if c.is_ascii_digit() {
            return Some(Key::Unicode(c));
        }
    }
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

    let pressed = enigo.key(key, Direction::Press);
    if pressed.is_ok() {
        std::thread::sleep(KEY_HOLD);
    }
    let released = enigo.key(key, Direction::Release);

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

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
        .invoke_handler(tauri::generate_handler![
            press_key,
            accessibility_trusted,
            open_accessibility_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
