//! What a terminal's shell is doing right now: the foreground command, the directory and the
//! title, so a tab can show more than the directory it started in.
//!
//! Two sources are combined. The operating system knows which process group owns the PTY and
//! what that process runs and where, which works for every shell without configuration. The
//! shell itself may report its directory (OSC 7) and a title (OSC 0/2) through the output the
//! mirror already parses; only that report can see past an SSH connection.
//!
//! Nothing polls on a timer: the session pokes the watcher whenever output arrives, and the
//! watcher reads the process facts a moment later, at most about once a second, plus once more
//! after output went quiet. An idle shell therefore costs nothing, which matters on phones.

use super::session::SessionsChanged;
use redoor_protocol::{
    api::terminals::{TerminalActivity, TerminalSessionStatus},
    wire::terminal::TerminalSessionRecord,
};
use std::os::fd::OwnedFd;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Notify, watch};
use tokio::time::Instant;

/// Wait after output before the processes are read, so the command a just-pressed Enter
/// starts has been forked by then.
const PROBE_DELAY: Duration = Duration::from_millis(400);
/// Shortest time between two reads of the processes while output keeps coming.
const PROBE_INTERVAL: Duration = Duration::from_secs(1);
/// Quiet time after which the processes are read once more, catching a command that started
/// or ended after the last read without printing anything since.
const SETTLE_DELAY: Duration = Duration::from_secs(3);
/// Longest command line reported; a tooltip has no use for a whole argument list.
const MAX_COMMAND_CHARS: usize = 300;

/// What the shell reported about itself through escape sequences, as the mirror parsed them.
/// Empty strings mean nothing was reported.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ShellReport {
    pub(crate) title: String,
    /// The raw OSC 7 value, usually a `file://host/path` URL.
    pub(crate) pwd: String,
}

/// What the operating system says about the shell's processes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ProcessFacts {
    /// Command line of the foreground job, `None` while the shell itself is in the foreground.
    command: Option<String>,
    /// Working directory of the foreground job, or of the shell when it is idle.
    cwd: Option<String>,
}

/// Reads the shell's process facts through the PTY it runs on.
pub(crate) struct ProcessProbe {
    /// A duplicate of the PTY's controller side, which tells the foreground process group.
    controller: OwnedFd,
    /// The shell's pid, which is also its process group id because it leads its session.
    shell_pid: i32,
}

impl ProcessProbe {
    /// Keeps the PTY controller to ask it later; the caller dups it, so the probe holding it
    /// never decides when the PTY closes for the session.
    pub(crate) fn new(controller: OwnedFd, shell_pid: i32) -> Self {
        Self {
            controller,
            shell_pid,
        }
    }

    /// Asks the PTY which process group is in the foreground and reads its command and
    /// directory. A group other than the shell's own is a job the shell started.
    async fn read(&self) -> ProcessFacts {
        let foreground = nix::unistd::tcgetpgrp(&self.controller)
            .ok()
            .map(nix::unistd::Pid::as_raw)
            .filter(|group| *group > 0 && *group != self.shell_pid);
        let job = match foreground {
            Some(group) => read_job(group).await,
            None => None,
        };
        let cwd = match &job {
            Some((pid, _)) => match os::cwd(*pid).await {
                Some(cwd) => Some(cwd),
                None => os::cwd(self.shell_pid).await,
            },
            None => os::cwd(self.shell_pid).await,
        };
        let command = job.map(|(_, command)| command);
        ProcessFacts {
            command: command.map(|command| truncate_chars(command, MAX_COMMAND_CHARS)),
            cwd,
        }
    }
}

/// The process that stands for the foreground job `group` and its command line.
///
/// The group id is its leader's pid, the first command of a pipeline, so the leader is read
/// first. The leader often exits while the rest still runs (`git log | less`), so then any
/// surviving member stands in, or the tab would claim the shell is at its prompt.
async fn read_job(group: i32) -> Option<(i32, String)> {
    if let Some(command) = os::command_line(group).await {
        return Some((group, command));
    }
    let member = os::group_member(group).await?;
    Some((member, os::command_line(member).await?))
}

/// Keeps one session's [`TerminalActivity`] current. Runs as its own task, so reading the
/// processes never holds up the session's output or commands.
pub(crate) struct ActivityWatcher {
    record: Arc<watch::Sender<TerminalSessionRecord>>,
    changed: SessionsChanged,
    /// Poked by the session for every output chunk; one stored permit stands for any number.
    output: Arc<Notify>,
    /// The mirror's view of what the shell reported, `None` without a mirror.
    reports: Option<watch::Receiver<ShellReport>>,
    /// `None` when the session has no real PTY, as in tests.
    probe: Option<ProcessProbe>,
    /// This machine's name, to tell a local shell's OSC 7 from a remote one's.
    hostname: Option<String>,
    /// The latest process facts.
    facts: ProcessFacts,
    last_probe: Option<Instant>,
    /// When the processes are read once more after output stopped.
    settle_at: Option<Instant>,
}

impl ActivityWatcher {
    /// Prepares a watcher; `reports` and `probe` are optional so a session without a mirror
    /// or without a real PTY still runs one.
    pub(crate) fn new(
        record: Arc<watch::Sender<TerminalSessionRecord>>,
        changed: SessionsChanged,
        output: Arc<Notify>,
        reports: Option<watch::Receiver<ShellReport>>,
        probe: Option<ProcessProbe>,
    ) -> Self {
        let hostname = nix::unistd::gethostname()
            .ok()
            .map(|name| name.to_string_lossy().into_owned());
        Self {
            record,
            changed,
            output,
            reports,
            probe,
            hostname,
            facts: ProcessFacts::default(),
            last_probe: None,
            settle_at: None,
        }
    }

    /// Follows output and shell reports until the session aborts the task.
    pub(crate) async fn run(mut self) {
        loop {
            tokio::select! {
                () = self.output.notified() => self.probe_after_output().await,
                () = sleep_until(self.settle_at) => self.settle().await,
                alive = report_changed(&mut self.reports) => self.report_received(alive),
            }
            self.publish();
        }
    }

    /// Reads the processes after output, throttled, and schedules the quiet re-read.
    async fn probe_after_output(&mut self) {
        self.wait_for_probe_slot().await;
        self.probe().await;
        self.settle_at = Some(Instant::now() + SETTLE_DELAY);
    }

    /// Output stayed quiet; one more read catches a silent start or end of a job.
    async fn settle(&mut self) {
        self.settle_at = None;
        self.probe().await;
    }

    /// Forgets a mirror that is gone, so its closed channel does not spin the loop.
    fn report_received(&mut self, alive: bool) {
        if !alive {
            self.reports = None;
        }
    }

    /// Waits out the delay before a read, so a burst of output costs one read a second.
    async fn wait_for_probe_slot(&self) {
        if self.probe.is_none() {
            return;
        }
        let mut at = Instant::now() + PROBE_DELAY;
        if let Some(last) = self.last_probe {
            at = at.max(last + PROBE_INTERVAL);
        }
        tokio::time::sleep_until(at).await;
    }

    /// Reads the processes; without a PTY nothing is known about them.
    async fn probe(&mut self) {
        if let Some(probe) = &self.probe {
            self.facts = probe.read().await;
        }
        self.last_probe = Some(Instant::now());
    }

    /// Stores the activity and tells the server, but only when it changed, so a busy shell
    /// does not make every browser reload its tab list. An exited session keeps what the
    /// session wrote when it finished.
    fn publish(&mut self) {
        let report = self
            .reports
            .as_mut()
            .map(|reports| reports.borrow_and_update().clone())
            .unwrap_or_default();
        let activity = combine(&self.facts, &report, self.hostname.as_deref());
        let modified = self.record.send_if_modified(|record| {
            if record.status != TerminalSessionStatus::Running || record.activity == activity {
                return false;
            }
            record.activity = activity;
            true
        });
        if modified {
            self.changed.send_replace(());
        }
    }
}

/// Waits for the next shell report; `false` once the mirror is gone. Never resolves without a
/// mirror.
async fn report_changed(reports: &mut Option<watch::Receiver<ShellReport>>) -> bool {
    match reports {
        Some(reports) => reports.changed().await.is_ok(),
        None => std::future::pending().await,
    }
}

/// Sleeps until `deadline`; never resolves without one.
async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// Decides what the tab shows from both sources.
///
/// The process directory is live and exact, so it wins for local shells. A shell's own OSC 7
/// report can be stale (many shells only send it at the prompt, so `cd x && cmd` reports the
/// old directory while `cmd` runs), but it is the only source that sees a remote shell, so a
/// report naming another host is used while a job such as `ssh` runs. At the local prompt the
/// remote report is outdated by definition, and when the processes cannot be read the
/// shell's report is still better than nothing.
fn combine(facts: &ProcessFacts, report: &ShellReport, hostname: Option<&str>) -> TerminalActivity {
    let reported = parse_osc7(&report.pwd);
    let remote = reported
        .as_ref()
        .filter(|(host, _)| facts.command.is_some() && !is_local_host(host, hostname))
        .map(|(host, path)| format!("{host}:{path}"));
    let current_dir = remote
        .or_else(|| facts.cwd.clone())
        .or_else(|| reported.map(|(_, path)| path));
    TerminalActivity {
        command: facts.command.clone(),
        current_dir,
        title: Some(report.title.trim())
            .filter(|title| !title.is_empty())
            .map(str::to_string),
    }
}

/// Whether an OSC 7 host names this machine; shells leave it empty or write `localhost` too.
fn is_local_host(host: &str, hostname: Option<&str>) -> bool {
    host.is_empty()
        || host.eq_ignore_ascii_case("localhost")
        || hostname.is_some_and(|name| {
            // Some shells send the short name, others the fully qualified one.
            let short = |name: &str| name.split('.').next().unwrap_or(name).to_ascii_lowercase();
            short(host) == short(name)
        })
}

/// Splits an OSC 7 value into host and decoded path.
///
/// Shells send `file://host/path` with the path percent-encoded; kitty's integration uses
/// `kitty-shell-cwd://` unencoded, and OSC 9;9 and iTerm2 send a bare path.
fn parse_osc7(value: &str) -> Option<(String, String)> {
    if value.starts_with('/') {
        return Some((String::new(), value.to_string()));
    }
    if let Some(rest) = value.strip_prefix("kitty-shell-cwd://") {
        let (host, path) = split_host(rest)?;
        return Some((host.to_string(), path.to_string()));
    }
    let rest = value.strip_prefix("file://")?;
    let (host, path) = split_host(rest)?;
    Some((host.to_string(), percent_decode(path)))
}

/// Splits `host/path` at the slash that starts the path.
fn split_host(rest: &str) -> Option<(&str, &str)> {
    let slash = rest.find('/')?;
    Some((&rest[..slash], &rest[slash..]))
}

/// Decodes `%XX` escapes; an invalid escape is kept as it was.
fn percent_decode(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let escaped = (bytes[index] == b'%')
            .then(|| path.get(index + 1..index + 3))
            .flatten()
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match escaped {
            Some(byte) => {
                decoded.push(byte);
                index += 3;
            }
            None => {
                decoded.push(bytes[index]);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// Shortens `text` to `max` characters, marking the cut with an ellipsis.
fn truncate_chars(text: String, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text,
    }
}

/// Joins NUL-separated arguments into one line the way a user would type them.
fn join_arguments<'a>(arguments: impl Iterator<Item = &'a [u8]>) -> Option<String> {
    let line = arguments
        .filter(|argument| !argument.is_empty())
        .map(String::from_utf8_lossy)
        .collect::<Vec<_>>()
        .join(" ");
    (!line.is_empty()).then_some(line)
}

/// Linux and Android (Termux) expose every process of the same user in procfs.
#[cfg(any(target_os = "linux", target_os = "android"))]
mod os {
    /// The process's arguments; procfs separates them with NUL bytes.
    pub(super) async fn command_line(pid: i32) -> Option<String> {
        let raw = tokio::fs::read(format!("/proc/{pid}/cmdline")).await.ok()?;
        super::join_arguments(raw.split(|byte| *byte == 0))
    }

    /// The process's working directory, as the kernel resolves it.
    pub(super) async fn cwd(pid: i32) -> Option<String> {
        let path = tokio::fs::read_link(format!("/proc/{pid}/cwd"))
            .await
            .ok()?;
        Some(path.to_string_lossy().into_owned())
    }

    /// A live process of process group `group` other than its leader, found by scanning
    /// procfs; only called when the leader is gone, so the scan is rare.
    pub(super) async fn group_member(group: i32) -> Option<i32> {
        let mut entries = tokio::fs::read_dir("/proc").await.ok()?;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<i32>().ok())
                .filter(|pid| *pid != group)
            else {
                continue;
            };
            let Ok(stat) = tokio::fs::read_to_string(entry.path().join("stat")).await else {
                continue;
            };
            if super::live_process_group(&stat) == Some(group) {
                return Some(pid);
            }
        }
        None
    }
}

/// The process group field of a procfs `stat` line, `None` for a zombie, whose command line
/// is already gone. Parsed after the last `)` because a process name may contain spaces and
/// parentheses.
#[cfg(any(target_os = "linux", target_os = "android", test))]
fn live_process_group(stat: &str) -> Option<i32> {
    let mut fields = stat.rsplit_once(") ")?.1.split_whitespace();
    let state = fields.next()?;
    if state == "Z" {
        return None;
    }
    fields.nth(1)?.parse().ok()
}

/// macOS has no procfs; `sysctl` and `libproc` answer the same questions.
#[cfg(target_os = "macos")]
mod os {
    use std::ffi::{CStr, c_int, c_void};

    /// The process's arguments from `KERN_PROCARGS2`. The calls do not block on I/O, but the
    /// runtime's threads are still kept free of syscalls that copy up to a megabyte.
    pub(super) async fn command_line(pid: i32) -> Option<String> {
        let raw = tokio::task::spawn_blocking(move || procargs(pid))
            .await
            .ok()??;
        super::parse_procargs2(&raw)
    }

    /// The process's working directory from `proc_pidinfo`.
    pub(super) async fn cwd(pid: i32) -> Option<String> {
        tokio::task::spawn_blocking(move || vnode_cwd(pid))
            .await
            .ok()?
    }

    /// `PROC_PGRP_ONLY` from `libproc.h`, which the libc crate does not define.
    const PROC_PGRP_ONLY: u32 = 2;
    /// Members listed per call; a pipeline has a handful.
    const MAX_GROUP_MEMBERS: usize = 64;

    /// A live process of process group `group` other than its leader.
    pub(super) async fn group_member(group: i32) -> Option<i32> {
        tokio::task::spawn_blocking(move || list_group(group))
            .await
            .ok()?
    }

    /// Lists the group's processes with `proc_listpids`.
    fn list_group(group: i32) -> Option<i32> {
        let mut pids = [0 as c_int; MAX_GROUP_MEMBERS];
        let size = c_int::try_from(std::mem::size_of_val(&pids)).ok()?;
        // SAFETY: `pids` is a writable buffer of exactly `size` bytes.
        let written = unsafe {
            libc::proc_listpids(
                PROC_PGRP_ONLY,
                u32::try_from(group).ok()?,
                pids.as_mut_ptr().cast::<c_void>(),
                size,
            )
        };
        let count = usize::try_from(written).ok()? / std::mem::size_of::<c_int>();
        pids.iter()
            .take(count)
            .copied()
            .find(|pid| *pid > 0 && *pid != group)
    }

    /// Reads the raw `KERN_PROCARGS2` buffer, sized by asking the kernel first.
    fn procargs(pid: i32) -> Option<Vec<u8>> {
        let mut mib: [c_int; 3] = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
        let mut size: libc::size_t = 0;
        // SAFETY: a null buffer only asks for the needed size, written to `size`.
        let sized = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                3,
                std::ptr::null_mut(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if sized != 0 || size == 0 {
            return None;
        }
        let mut buffer = vec![0u8; size];
        // SAFETY: `buffer` holds `size` writable bytes and the kernel updates `size` to the
        // amount it wrote.
        let read = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                3,
                buffer.as_mut_ptr().cast::<c_void>(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if read != 0 {
            return None;
        }
        buffer.truncate(size);
        Some(buffer)
    }

    /// Reads the current directory vnode's path.
    fn vnode_cwd(pid: i32) -> Option<String> {
        // SAFETY: the struct is plain data, for which all zeroes is a valid value.
        let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
        let size = c_int::try_from(std::mem::size_of::<libc::proc_vnodepathinfo>()).ok()?;
        // SAFETY: `info` is a writable buffer of exactly `size` bytes.
        let written = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDVNODEPATHINFO,
                0,
                (&raw mut info).cast::<c_void>(),
                size,
            )
        };
        if written != size {
            return None;
        }
        let path = &info.pvi_cdir.vip_path;
        // SAFETY: `vip_path` is a contiguous MAXPATHLEN byte array inside `info`.
        let bytes = unsafe {
            std::slice::from_raw_parts(path.as_ptr().cast::<u8>(), std::mem::size_of_val(path))
        };
        let path = CStr::from_bytes_until_nul(bytes).ok()?.to_string_lossy();
        (!path.is_empty()).then(|| path.into_owned())
    }
}

/// Other Unix systems are not supported targets; the tab then shows only what the shell
/// reports itself.
#[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
mod os {
    /// Not known on this system.
    pub(super) async fn command_line(_pid: i32) -> Option<String> {
        None
    }

    /// Not known on this system.
    pub(super) async fn cwd(_pid: i32) -> Option<String> {
        None
    }

    /// Not known on this system.
    pub(super) async fn group_member(_group: i32) -> Option<i32> {
        None
    }
}

/// Extracts the arguments from a macOS `KERN_PROCARGS2` buffer: the argument count, the
/// executable path, NUL padding, then the arguments followed by the environment, which must
/// not leak into the tab.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn parse_procargs2(raw: &[u8]) -> Option<String> {
    let count = usize::try_from(i32::from_ne_bytes(raw.get(..4)?.try_into().ok()?)).ok()?;
    let rest = raw.get(4..)?;
    let path_end = rest.iter().position(|byte| *byte == 0)?;
    let rest = &rest[path_end..];
    let start = rest.iter().position(|byte| *byte != 0)?;
    join_arguments(rest[start..].split(|byte| *byte == 0).take(count))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Process facts of a command running in a local shell.
    fn running(command: &str, cwd: &str) -> ProcessFacts {
        ProcessFacts {
            command: Some(command.to_string()),
            cwd: Some(cwd.to_string()),
        }
    }

    fn report(title: &str, pwd: &str) -> ShellReport {
        ShellReport {
            title: title.to_string(),
            pwd: pwd.to_string(),
        }
    }

    #[test]
    fn local_process_directory_wins_over_a_stale_shell_report() {
        // `cd /work && make` leaves the shell's last OSC 7 at the old directory while make
        // runs; the process directory is the truth.
        let activity = combine(
            &running("make", "/work"),
            &report("", "file://box/home/me"),
            Some("box"),
        );
        assert_eq!(activity.current_dir.as_deref(), Some("/work"));
        assert_eq!(activity.command.as_deref(), Some("make"));
    }

    #[test]
    fn remote_shell_report_is_shown_with_its_host_while_a_job_runs() {
        // Through ssh only the remote shell's own report knows the directory.
        let activity = combine(
            &running("ssh server", "/home/me"),
            &report("me@server", "file://server.example.com/srv/app"),
            Some("laptop"),
        );
        assert_eq!(
            activity.current_dir.as_deref(),
            Some("server.example.com:/srv/app")
        );
        assert_eq!(activity.title.as_deref(), Some("me@server"));
    }

    #[test]
    fn remote_report_is_ignored_back_at_the_local_prompt() {
        let idle = ProcessFacts {
            command: None,
            cwd: Some("/home/me".to_string()),
        };
        // After ssh exits, a local shell that sends no OSC 7 would otherwise keep the remote
        // directory forever.
        let activity = combine(&idle, &report("", "file://server/srv"), Some("laptop"));
        assert_eq!(activity.current_dir.as_deref(), Some("/home/me"));
        assert_eq!(activity.command, None);
    }

    #[test]
    fn shell_report_fills_in_when_processes_are_unknown() {
        // Without process facts the decoded report is still better than nothing.
        let activity = combine(
            &ProcessFacts::default(),
            &report("  ", "file://localhost/tmp/with%20space"),
            None,
        );
        assert_eq!(activity.current_dir.as_deref(), Some("/tmp/with space"));
        // A blank title is no title.
        assert_eq!(activity.title, None);
    }

    #[test]
    fn parses_osc7_forms() {
        // The common percent-encoded URL with a host.
        assert_eq!(
            parse_osc7("file://host/a%2Fb%zz/%C3%A4"),
            Some(("host".to_string(), "/a/b%zz/ä".to_string()))
        );
        // kitty's unencoded form.
        assert_eq!(
            parse_osc7("kitty-shell-cwd://h/x y"),
            Some(("h".to_string(), "/x y".to_string()))
        );
        // A bare path, as OSC 9;9 sends it.
        assert_eq!(
            parse_osc7("/plain"),
            Some((String::new(), "/plain".to_string()))
        );
        // Nothing reported, or something that is no directory.
        assert_eq!(parse_osc7(""), None);
        assert_eq!(parse_osc7("http://x/y"), None);
    }

    #[test]
    fn local_host_names_match_short_and_qualified_forms() {
        assert!(is_local_host("", Some("box")));
        assert!(is_local_host("localhost", None));
        // A shell may send the FQDN while the agent knows the short name, or the reverse.
        assert!(is_local_host("box.lan", Some("box")));
        assert!(is_local_host("BOX", Some("box.lan")));
        assert!(!is_local_host("other", Some("box")));
    }

    #[test]
    fn parses_macos_procargs() {
        let mut raw = 2i32.to_ne_bytes().to_vec();
        raw.extend_from_slice(b"/bin/sleep\0\0\0\0sleep\x00300\0HOME=/secret\0");
        // Only the arguments are shown, never the environment that follows them.
        assert_eq!(parse_procargs2(&raw).as_deref(), Some("sleep 300"));
        // A truncated buffer is not an argument list.
        assert_eq!(parse_procargs2(&[1, 0]), None);
    }

    #[test]
    fn long_commands_are_cut_on_a_character_boundary() {
        // Multi-byte characters must not be split.
        assert_eq!(truncate_chars("ääää".to_string(), 2), "ää…");
        assert_eq!(truncate_chars("short".to_string(), 10), "short");
    }

    #[test]
    fn parses_the_process_group_of_live_processes_only() {
        // A name with spaces and parentheses must not shift the fields.
        assert_eq!(live_process_group("7 (a) b) S 1 42 42 0"), Some(42));
        // A zombie's command line is gone, so it cannot stand in for its job.
        assert_eq!(live_process_group("7 (sh) Z 1 42 42 0"), None);
    }

    /// The leader of a pipeline such as `git log | less` exits first; the job must still be
    /// reported through a member that is left, not as the shell prompt.
    #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
    #[tokio::test]
    async fn job_whose_leader_exited_is_read_from_a_surviving_member() {
        let mut leader = tokio::process::Command::new("sleep")
            .arg("300")
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let group = i32::try_from(leader.id().unwrap()).unwrap();
        // `spawn` returns after exec, so the member's command line is already its own.
        let _member = tokio::process::Command::new("sleep")
            .arg("301")
            .process_group(group)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        leader.start_kill().unwrap();
        // Reaped, so the leader is gone from the process table, as after a pipeline's
        // first command exits.
        leader.wait().await.unwrap();
        let (_, command) = read_job(group).await.expect("a job is still running");
        // The member that is left names the job.
        assert_eq!(command, "sleep 301");
    }

    /// The OS layer must read a real process; the test process stands in for a shell job.
    #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
    #[tokio::test]
    async fn reads_a_real_process_command_and_directory() {
        let pid = i32::try_from(std::process::id()).unwrap();
        let command = os::command_line(pid).await.expect("command line");
        // The test binary's own path starts its command line.
        let executable = std::env::args().next().unwrap();
        assert!(command.starts_with(&executable), "{command}");
        let cwd = os::cwd(pid).await.expect("cwd");
        // The kernel's view matches what the process itself sees.
        assert_eq!(
            std::path::Path::new(&cwd),
            std::env::current_dir().unwrap().canonicalize().unwrap()
        );
    }
}
