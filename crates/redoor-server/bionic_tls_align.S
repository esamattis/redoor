/*
 * Raises the executable's TLS segment alignment to 64 bytes on arm64 Android.
 *
 * Why: Bionic reserves thread-pointer slots ahead of the executable's TLS block on arm64 and
 * refuses to start a binary whose PT_TLS alignment is below 64 ("executable's TLS segment is
 * underaligned"). Rust's Android targets use emulated TLS, but libghostty-vt is built by Zig,
 * whose standard library emits native ELF thread-locals aligned to only 8 bytes. The linker sizes
 * the TLS segment alignment as the largest input alignment, so this single 64-byte-aligned byte
 * lifts the whole segment to what Bionic requires.
 *
 * The "R" flag (SHF_GNU_RETAIN) makes the section a garbage collection root, because nothing
 * references the symbol and `--gc-sections` would otherwise drop it. build.rs links the archive
 * with `+whole-archive` so the object is not skipped for resolving no undefined symbol.
 */
.section .tbss.redoor_bionic_tls_align,"awTR",@nobits
.p2align 6
.globl redoor_bionic_tls_align
.type redoor_bionic_tls_align, @object
redoor_bionic_tls_align:
.zero 1
.size redoor_bionic_tls_align, 1
