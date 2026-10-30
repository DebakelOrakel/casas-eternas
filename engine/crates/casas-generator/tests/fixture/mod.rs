//! The check of a fixture's line, and its record mode
//! (docs/decisions/rust-engine.md, fork 7c). The fixtures were written by
//! the TypeScript engine; a change to the model that is meant records the
//! fixtures it moves from this engine: `CASAS_RECORD=1 cargo test --release
//! --test <name>` writes the engine's line into the fixture where it
//! differs, and the diff shows what moved. Native only: the WASM build
//! reads the fixtures it was built with.

use std::sync::Mutex;

// One test binary runs both shapes at once, and both write one file.
static FILES: Mutex<()> = Mutex::new(());

fn recording() -> bool {
    std::env::var_os("CASAS_RECORD").is_some_and(|v| v == "1")
}

/// `want` is a line of `tests/fixtures/<file>`, `got` the engine's.
#[track_caller]
pub fn check(file: &str, got: &str, want: &str, what: &str) {
    if !recording() {
        assert_eq!(got, want, "{what}");
        return;
    }
    if got == want {
        return;
    }
    let _files = FILES.lock().unwrap_or_else(|e| e.into_inner());
    let path = format!("{}/tests/fixtures/{file}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap();
    assert_eq!(
        text.lines().filter(|&l| l == want).count(),
        1,
        "{file}: the line to record is not once in the fixture: {want}"
    );
    let lines: Vec<&str> = text
        .lines()
        .map(|l| if l == want { got } else { l })
        .collect();
    std::fs::write(&path, lines.join("\n") + "\n").unwrap();
}
