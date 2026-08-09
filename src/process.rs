use std::ffi::OsString;

/// Replaces this process with the same executable and arguments so supervisors keep tracking it.
pub fn reexec_current_process() -> ! {
    use std::os::unix::process::CommandExt;

    let exe = std::env::current_exe().unwrap_or_else(|error| {
        eprintln!("restart: failed to resolve current executable: {error}");
        std::process::exit(1);
    });
    // Command supplies argv[0], so only the original arguments are forwarded.
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();

    let error = std::process::Command::new(&exe).args(&args).exec();
    eprintln!("restart: exec failed for {}: {error}", exe.display());
    std::process::exit(1);
}
