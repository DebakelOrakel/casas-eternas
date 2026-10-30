//! Prints the pipeline's constants as JSON (`casas_generator_api::pipeline`);
//! `make engine` writes them to `engine/dist/constants.json`.

fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&casas_generator_api::pipeline::constants())
            .expect("the constants are finite numbers")
    );
}
