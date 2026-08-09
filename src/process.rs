use std::{ffi::OsString, path::Path};

/// Replaces this process with the same executable and arguments so supervisors keep tracking it.
pub fn reexec_current_process() -> ! {
    let exe = std::env::current_exe().unwrap_or_else(|error| {
        eprintln!("restart: failed to resolve current executable: {error}");
        std::process::exit(1);
    });
    reexec_process(&exe)
}

/// Replaces this process from an explicit installed path after an atomic binary upgrade.
pub fn reexec_process(exe: &Path) -> ! {
    use std::os::unix::process::CommandExt;

    // Command supplies argv[0], so only the original arguments are forwarded.
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();

    let error = std::process::Command::new(exe).args(&args).exec();
    eprintln!("restart: exec failed for {}: {error}", exe.display());
    std::process::exit(1);
}
