#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::{fs, path::Path};

#[tauri::command]
fn read_dropped_file(path: String) -> Result<String, String> {
    let path = Path::new(&path);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "The dropped file has no supported image extension".to_string())?;
    let (mime, valid, max_size): (&str, fn(&[u8]) -> bool, usize) = match extension.as_str() {
        "png" => ("image/png", |bytes: &[u8]| bytes.starts_with(b"\x89PNG\r\n\x1a\n"), 10 * 1024 * 1024),
        "jpg" | "jpeg" => ("image/jpeg", |bytes: &[u8]| bytes.starts_with(&[0xff, 0xd8, 0xff]), 10 * 1024 * 1024),
        "gif" => ("image/gif", |bytes: &[u8]| {
            bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")
        }, 10 * 1024 * 1024),
        "webp" => ("image/webp", |bytes: &[u8]| {
            bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP"
        }, 10 * 1024 * 1024),
        "bmp" => ("image/bmp", |bytes: &[u8]| bytes.starts_with(b"BM"), 10 * 1024 * 1024),
        "pdf" => ("application/pdf", |bytes: &[u8]| bytes.starts_with(b"%PDF-"), 50 * 1024 * 1024),
        _ => return Err("Unsupported dropped file format".to_string()),
    };

    let file_size = fs::metadata(path)
        .map_err(|error| format!("Could not inspect dropped file: {error}"))?
        .len();
    if file_size > max_size as u64 {
        return Err(format!("Dropped file exceeds the {} MB limit", max_size / (1024 * 1024)));
    }
    let bytes = fs::read(path).map_err(|error| format!("Could not read dropped file: {error}"))?;
    if !valid(&bytes) {
        return Err("The dropped file is not a valid image".to_string());
    }

    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![read_dropped_file])
        .run(tauri::generate_context!())
        .expect("error while running whiteboard");
}
