//! Writes the history's version as JSON (`make engine` →
//! `dist/history/version.json`), for the client's artifact keys
//! (`casas_history::tuning::history_version`).

fn main() {
    println!(
        "{{\"version\":\"{}\"}}",
        casas_history::tuning::history_version()
    );
}
