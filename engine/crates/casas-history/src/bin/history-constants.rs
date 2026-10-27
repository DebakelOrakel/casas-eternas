//! Prints the history's tuning as JSON (`casas_history::tuning::constants`);
//! `make engine` writes it to `dist/history/constants.json`, as the
//! engine's constants.json: what the history's version hashes.

fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&casas_history::tuning::constants())
            .expect("the constants are finite numbers")
    );
}
