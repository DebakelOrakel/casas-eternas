//! Writes the history's version as JSON (`make engine` →
//! `dist/history/version.json`), for the client's artifact keys.

fn main() {
    println!("{{\"version\":\"{}\"}}", casas_history::HISTORY_VERSION);
}
