use enigo::{Direction, Enigo, Key, Keyboard, Settings};

/// Map a browser `KeyboardEvent.code` to an enigo key. Using `code` (physical
/// key) rather than `key` (produced character) keeps WASD/arrows/etc. working
/// regardless of layout and matches what games typically read.
fn code_to_key(code: &str) -> Option<Key> {
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

/// Tap a key (press + release) at the OS level. `code` is a browser
/// `KeyboardEvent.code` value supplied by the frontend's key-capture UI.
#[tauri::command]
fn press_key(code: String) -> Result<(), String> {
    let key = code_to_key(&code).ok_or_else(|| format!("Unsupported key: {code}"))?;
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo
        .key(key, Direction::Click)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![press_key])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
