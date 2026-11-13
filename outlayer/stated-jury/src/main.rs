//! WASI Preview 2 transport. No endpoint, key, model or network policy is caller configurable.
#[cfg(all(target_arch = "wasm32", target_os = "wasi"))]
mod http;

#[cfg(all(target_arch = "wasm32", target_os = "wasi"))]
fn main() {
    use std::io::{Read, Write};
    let execute = || -> Result<String, String> {
        let mut text = String::new();
        std::io::stdin()
            .take(32_769)
            .read_to_string(&mut text)
            .map_err(|_| "Cannot read input")?;
        if text.len() > 32_768 {
            return Err("Input exceeds 32768 bytes".into());
        }
        let input = serde_json::from_str(&text).map_err(|_| "Invalid execution input")?;
        let mut transport = http::Https::from_secret()?;
        serde_json::to_string(&stated_jury::run(input, &mut transport)?)
            .map_err(|_| "Cannot encode result".into())
    };
    match execute() {
        Ok(output) => {
            if std::io::stdout().write_all(output.as_bytes()).is_err() {
                std::process::exit(1);
            }
        }
        Err(error) => {
            eprintln!("Jury execution failed: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(not(all(target_arch = "wasm32", target_os = "wasi")))]
fn main() {
    eprintln!("Run the wasm32-wasip2 component in OutLayer; native tests use the mock Transport.");
    std::process::exit(1);
}
