//! Build glue for the agent crate, which links `libghostty-vt` for its terminal mirrors.

fn main() {
    link_bionic_tls_align();
}

/// Links `bionic_tls_align.S` into arm64 Android builds so Bionic accepts the binary's TLS segment.
///
/// libghostty-vt brings Zig thread-locals aligned to 8 bytes, and Bionic aborts at startup unless
/// the executable's TLS segment is aligned to at least 64 bytes on arm64. Other targets have no
/// such requirement, so they skip the object entirely.
///
/// The archive is linked with `+whole-archive` because nothing references its symbol: a plain
/// static library member is only pulled in to resolve an undefined symbol. Cargo only forwards
/// `rustc-link-arg` from a build script to the package's own binaries, which this library has
/// none of, so `-Wl,--undefined` cannot reach the final `redoor` link from here.
fn link_bionic_tls_align() {
    println!("cargo:rerun-if-changed=bionic_tls_align.S");

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if target_os != "android" || target_arch != "aarch64" {
        return;
    }

    cc::Build::new()
        .file("bionic_tls_align.S")
        .link_lib_modifier("+whole-archive")
        .compile("redoor_bionic_tls_align");
}
