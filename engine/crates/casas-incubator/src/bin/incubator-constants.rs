//! Prints the incubator's tuning as JSON (`casas_incubator::tuning::constants`);
//! `make engine` writes it to `dist/incubator/constants.json`, as the
//! engine's constants.json: what the incubator's version hashes.

fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&casas_incubator::tuning::constants())
            .expect("the constants are finite numbers")
    );
}
