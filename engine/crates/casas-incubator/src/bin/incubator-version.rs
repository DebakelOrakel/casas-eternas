//! Writes the incubator's version as JSON (`make engine` →
//! `dist/incubator/version.json`), for the client's artifact keys
//! (`casas_incubator::tuning::incubator_version`).

fn main() {
    println!(
        "{{\"version\":\"{}\"}}",
        casas_incubator::tuning::incubator_version()
    );
}
