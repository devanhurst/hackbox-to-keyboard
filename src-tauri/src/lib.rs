//! Keyboard synthesis is platform-split. On Windows we drive Win32 `SendInput`
//! directly so every injected event carries BOTH a virtual-key code AND a scan
//! code (mirroring the original Unity app's InputSimulator). Game console
//! emulators (PlayStation, Dolphin) read keyboard input via DirectInput / Raw
//! Input, which key off the scan code / VKey fields; an event that sets only one
//! of them — as the cross-platform `enigo` crate does — is delivered to ordinary
//! message-queue apps (e.g. a text field) but silently ignored by those games.
//! On macOS/Linux `enigo` already posts proper keycode-based events, so we use it
//! there.

/// Tap a key (press + release) at the OS level, holding any modifiers down for
/// the duration. `code` is a browser `KeyboardEvent.code`; `modifiers` are
/// names like "Shift"/"Control"/"Alt"/"Meta" supplied by the capture UI.
#[tauri::command]
fn press_key(code: String, modifiers: Vec<String>) -> Result<(), String> {
    platform::press_key(&code, &modifiers)
}

#[cfg(windows)]
mod platform {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC, VIRTUAL_KEY, VK_BACK, VK_CONTROL,
        VK_DOWN, VK_ESCAPE, VK_LCONTROL, VK_LEFT, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_MENU, VK_OEM_1,
        VK_OEM_2, VK_OEM_3, VK_OEM_4, VK_OEM_5, VK_OEM_6, VK_OEM_7, VK_OEM_COMMA, VK_OEM_MINUS,
        VK_OEM_PERIOD, VK_OEM_PLUS, VK_RCONTROL, VK_RETURN, VK_RIGHT, VK_RMENU, VK_RSHIFT, VK_RWIN,
        VK_SHIFT, VK_SPACE, VK_TAB, VK_UP,
    };

    /// Map a browser `KeyboardEvent.code` to a Win32 virtual-key code plus whether
    /// it is an "extended" key. Extended keys (arrows, right-hand modifiers, the
    /// numpad Enter, the Windows keys) must carry `KEYEVENTF_EXTENDEDKEY` so the OS
    /// and games disambiguate them from their non-extended twins (e.g. arrow keys
    /// vs. the numpad navigation keys). Using `code` (physical key) rather than the
    /// produced character keeps WASD/arrows working regardless of layout.
    fn code_to_vk(code: &str) -> Option<(VIRTUAL_KEY, bool)> {
        // Letters: "KeyA" -> VK_A (0x41). Win32 letter VKs are the ASCII uppercase.
        if let Some(letter) = code.strip_prefix("Key") {
            let c = letter.chars().next()?;
            return Some((VIRTUAL_KEY(c.to_ascii_uppercase() as u16), false));
        }
        // Top-row digits: "Digit1" -> VK_1 (0x31), which is the ASCII digit.
        if let Some(digit) = code.strip_prefix("Digit") {
            let c = digit.chars().next()?;
            if c.is_ascii_digit() {
                return Some((VIRTUAL_KEY(c as u16), false));
            }
        }
        // Numpad digits: "Numpad1" -> VK_NUMPAD1 (0x61).
        if let Some(digit) = code.strip_prefix("Numpad") {
            let c = digit.chars().next()?;
            if c.is_ascii_digit() {
                return Some((VIRTUAL_KEY(0x60 + (c as u8 - b'0') as u16), false));
            }
        }
        // Function keys: "F1".."F12" -> VK_F1 (0x70) ..= VK_F12 (0x7B).
        if let Some(n) = code.strip_prefix('F') {
            if let Ok(num) = n.parse::<u8>() {
                if (1..=12).contains(&num) {
                    return Some((VIRTUAL_KEY(0x70 + (num as u16 - 1)), false));
                }
                return None;
            }
        }

        let mapped = match code {
            "Space" => (VK_SPACE, false),
            "Enter" => (VK_RETURN, false),
            "NumpadEnter" => (VK_RETURN, true),
            "Tab" => (VK_TAB, false),
            "Backspace" => (VK_BACK, false),
            "Escape" => (VK_ESCAPE, false),
            "ArrowUp" => (VK_UP, true),
            "ArrowDown" => (VK_DOWN, true),
            "ArrowLeft" => (VK_LEFT, true),
            "ArrowRight" => (VK_RIGHT, true),
            "ShiftLeft" => (VK_LSHIFT, false),
            "ShiftRight" => (VK_RSHIFT, false),
            "ControlLeft" => (VK_LCONTROL, false),
            "ControlRight" => (VK_RCONTROL, true),
            "AltLeft" => (VK_LMENU, false),
            "AltRight" => (VK_RMENU, true),
            "MetaLeft" => (VK_LWIN, true),
            "MetaRight" => (VK_RWIN, true),
            "Minus" => (VK_OEM_MINUS, false),
            "Equal" => (VK_OEM_PLUS, false),
            "BracketLeft" => (VK_OEM_4, false),
            "BracketRight" => (VK_OEM_6, false),
            "Backslash" => (VK_OEM_5, false),
            "Semicolon" => (VK_OEM_1, false),
            "Quote" => (VK_OEM_7, false),
            "Comma" => (VK_OEM_COMMA, false),
            "Period" => (VK_OEM_PERIOD, false),
            "Slash" => (VK_OEM_2, false),
            "Backquote" => (VK_OEM_3, false),
            _ => return None,
        };
        Some(mapped)
    }

    /// Map a modifier name from the frontend to its virtual-key code. The Windows
    /// keys are extended; Control/Alt/Shift here use the generic (side-agnostic)
    /// VKs, matching what the original app held down for combos.
    fn modifier_to_vk(name: &str) -> Option<(VIRTUAL_KEY, bool)> {
        Some(match name {
            "Control" => (VK_CONTROL, false),
            "Alt" => (VK_MENU, false),
            "Shift" => (VK_SHIFT, false),
            "Meta" => (VK_LWIN, true),
            _ => return None,
        })
    }

    /// Build one keyboard `INPUT`, populating BOTH `wVk` and `wScan`. Populating
    /// both is the whole point of the Windows path: it is what lets DirectInput /
    /// Raw Input games see the key (see module docs).
    fn key_input(vk: VIRTUAL_KEY, extended: bool, up: bool) -> INPUT {
        let scan = unsafe { MapVirtualKeyW(vk.0 as u32, MAPVK_VK_TO_VSC) } as u16;
        let mut flags = KEYBD_EVENT_FLAGS(0);
        if extended {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        if up {
            flags |= KEYEVENTF_KEYUP;
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    pub fn press_key(code: &str, modifiers: &[String]) -> Result<(), String> {
        let (vk, extended) = code_to_vk(code).ok_or_else(|| format!("Unsupported key: {code}"))?;
        let mods: Vec<(VIRTUAL_KEY, bool)> =
            modifiers.iter().filter_map(|m| modifier_to_vk(m)).collect();

        // Order mirrors InputSimulator's ModifiedKeyStroke: modifiers down, the
        // key down+up, then modifiers up in reverse — all in a single SendInput
        // batch so nothing else can interleave between them.
        let mut inputs: Vec<INPUT> = Vec::with_capacity(mods.len() * 2 + 2);
        for (mvk, mext) in &mods {
            inputs.push(key_input(*mvk, *mext, false));
        }
        inputs.push(key_input(vk, extended, false));
        inputs.push(key_input(vk, extended, true));
        for (mvk, mext) in mods.iter().rev() {
            inputs.push(key_input(*mvk, *mext, true));
        }

        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize != inputs.len() {
            return Err(format!(
                "SendInput injected {sent} of {} events",
                inputs.len()
            ));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod platform {
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

    pub fn press_key(code: &str, modifiers: &[String]) -> Result<(), String> {
        let key = code_to_key(code).ok_or_else(|| format!("Unsupported key: {code}"))?;
        let mods: Vec<Key> = modifiers.iter().filter_map(|m| modifier_to_key(m)).collect();

        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

        for m in &mods {
            enigo.key(*m, Direction::Press).map_err(|e| e.to_string())?;
        }

        let tap = enigo.key(key, Direction::Click);

        // Always release modifiers, even if the tap failed, so we don't leave a
        // modifier stuck down at the OS level.
        for m in mods.iter().rev() {
            let _ = enigo.key(*m, Direction::Release);
        }

        tap.map_err(|e| e.to_string())?;
        Ok(())
    }
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
