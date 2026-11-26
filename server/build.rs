fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    // include_dir does not track ../dist on stable, so rebuild when the web app changes.
    if std::env::var_os("CARGO_FEATURE_EMBED_WEB").is_some() {
        println!("cargo:rerun-if-changed=../dist");
    }
}
