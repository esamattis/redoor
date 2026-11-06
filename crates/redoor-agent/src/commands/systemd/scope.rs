//! Who a systemd request acts on and whether the agent may do it.
//!
//! Every request is checked here before any child process starts, so a non-root agent never
//! even asks systemd to do something it may not, and unit and user names are validated before
//! they become process arguments.

use nix::unistd::{Uid, User};
use redoor_protocol::{
    api::systemd::SystemdScope,
    wire::{command::CommandErrorKind, request::CommandError},
};
use std::path::{Path, PathBuf};

/// Unit type suffixes systemd knows; a name without one is not a unit.
const UNIT_SUFFIXES: &[&str] = &[
    "service",
    "socket",
    "device",
    "mount",
    "automount",
    "swap",
    "target",
    "path",
    "timer",
    "slice",
    "scope",
];

/// Longest unit name systemd accepts (`UNIT_NAME_MAX` minus its terminator).
const MAX_UNIT_NAME_BYTES: usize = 255;

/// Longest account name accepted from a request; far above any real login name, but it keeps
/// a hostile request from reaching NSS with megabytes.
const MAX_USER_NAME_BYTES: usize = 256;

/// Directory of the per-user runtime directories, where a running user manager has its
/// sockets.
pub(super) const USER_RUNTIME_ROOT: &str = "/run/user";

/// Directory with one empty file per account whose linger is enabled; logind's own record.
pub(super) const LINGER_DIRECTORY: &str = "/var/lib/systemd/linger";

/// Checks that `name` is a plain unit name, so it cannot be read as a glob by `journalctl -u`
/// or as a path, and fails before any process starts.
///
/// Allows the characters systemd itself allows (`[A-Za-z0-9:_.\@-]`) and requires a known
/// type suffix. Templates (`foo@.service`) are valid names. A leading `-` is allowed because
/// the root mount is `-.mount`; unit names always follow `--` or an `=`, so they are never
/// read as options.
pub(super) fn validate_unit_name(name: &str) -> Result<(), CommandError> {
    let invalid = |reason: &str| {
        Err(CommandError::new(
            CommandErrorKind::InvalidInput,
            format!("Invalid unit name \"{name}\": {reason}"),
        ))
    };
    if name.is_empty() || name.len() > MAX_UNIT_NAME_BYTES {
        return invalid("it must be 1 to 255 characters long");
    }
    if let Some(character) = name
        .chars()
        .find(|character| !(character.is_ascii_alphanumeric() || ":_.\\@-".contains(*character)))
    {
        return invalid(&format!("it contains the character {character:?}"));
    }
    if name.starts_with('.') {
        return invalid("it must not start with '.'");
    }
    let Some((prefix, suffix)) = name.rsplit_once('.') else {
        return invalid("it has no unit type suffix such as .service");
    };
    if !UNIT_SUFFIXES.contains(&suffix) {
        return invalid(&format!("\".{suffix}\" is not a unit type"));
    }
    if prefix.is_empty() || prefix.starts_with('@') || prefix.matches('@').count() > 1 {
        return invalid("the name before the type is malformed");
    }
    Ok(())
}

/// Whether `unit` is a template such as `getty@.service`, which systemd cannot report a
/// status for; only its instances have one.
pub(super) fn is_template(unit: &str) -> bool {
    unit.rsplit_once('.')
        .is_some_and(|(prefix, _)| prefix.ends_with('@'))
}

/// The type suffix of a validated unit name, such as `service`.
pub(super) fn unit_type(unit: &str) -> &str {
    unit.rsplit_once('.').map_or("", |(_, suffix)| suffix)
}

/// Checks a requested account name before it is looked up, so it can never be read as an
/// option by `loginctl` or contain a path separator.
fn validate_user_name(name: &str) -> Result<(), CommandError> {
    let valid = !name.is_empty()
        && name.len() <= MAX_USER_NAME_BYTES
        && !name.starts_with('-')
        && !name
            .chars()
            .any(|character| character == '/' || character == ':' || character.is_whitespace())
        && !name.chars().any(char::is_control);
    if valid {
        Ok(())
    } else {
        Err(CommandError::new(
            CommandErrorKind::InvalidInput,
            format!("Invalid user name \"{name}\""),
        ))
    }
}

/// One account from the host's user database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Account {
    pub(super) name: String,
    pub(super) uid: u32,
    pub(super) gid: u32,
    pub(super) home: PathBuf,
}

impl Account {
    /// Looks up the account a request names; unknown names are `NotFound`, so the UI can tell
    /// a typo from a refusal.
    pub(super) async fn by_name(name: &str) -> Result<Self, CommandError> {
        validate_user_name(name)?;
        let lookup = name.to_string();
        let user = Self::lookup(move || User::from_name(&lookup)).await?;
        user.ok_or_else(|| {
            CommandError::new(
                CommandErrorKind::NotFound,
                format!("User \"{name}\" does not exist on the device"),
            )
        })
    }

    /// Looks up the account of a UID, for the agent itself and for user managers found in
    /// `/run/user`.
    pub(super) async fn by_uid(uid: u32) -> Result<Option<Self>, CommandError> {
        Self::lookup(move || User::from_uid(Uid::from_raw(uid))).await
    }

    /// Runs one NSS lookup off the async runtime under the process-wide NSS lock, because
    /// libc lookups block (LDAP, SSSD) and share global state with ownership lookups.
    async fn lookup(
        query: impl FnOnce() -> nix::Result<Option<User>> + Send + 'static,
    ) -> Result<Option<Self>, CommandError> {
        let user = redoor_core::logging::spawn_blocking_in_user_scope(move || {
            crate::ownership::with_nss_lock(query)
        })
        .await
        .map_err(|error| {
            CommandError::new(
                CommandErrorKind::Internal,
                format!("Account lookup worker failed: {error}"),
            )
        })?
        .map_err(|error| {
            CommandError::new(
                CommandErrorKind::Internal,
                format!("Account lookup failed: {error}"),
            )
        })?;
        Ok(user.map(|user| Self {
            name: user.name,
            uid: user.uid.as_raw(),
            gid: user.gid.as_raw(),
            home: user.dir,
        }))
    }

    /// `/run/user/<uid>`, where the user's manager and bus keep their sockets.
    pub(super) fn runtime_dir(&self) -> PathBuf {
        PathBuf::from(USER_RUNTIME_ROOT).join(self.uid.to_string())
    }

    /// Whether the user's manager runs; see [`manager_sockets_exist`].
    pub(super) async fn manager_running(&self) -> bool {
        manager_sockets_exist(&self.runtime_dir()).await
    }

    /// Whether linger is enabled, read from logind's state directory, which every account
    /// may read.
    pub(super) async fn linger(&self) -> bool {
        tokio::fs::try_exists(PathBuf::from(LINGER_DIRECTORY).join(&self.name))
            .await
            .unwrap_or(false)
    }
}

/// The account the agent process runs as, looked up by effective UID because `$USER` is
/// wrong under systemd `User=` and `su`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct AgentAccount {
    pub(super) account: Account,
    pub(super) is_root: bool,
}

impl AgentAccount {
    /// Reads the agent's own account; an account missing from NSS (a container started with
    /// a bare UID) still works under a numeric name.
    pub(super) async fn current() -> Result<Self, CommandError> {
        let uid = Uid::effective();
        let account = match Account::by_uid(uid.as_raw()).await? {
            Some(account) => account,
            None => Account {
                name: uid.to_string(),
                uid: uid.as_raw(),
                gid: nix::unistd::Gid::effective().as_raw(),
                home: std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("/")),
            },
        };
        Ok(Self {
            account,
            is_root: uid.is_root(),
        })
    }
}

/// What a request does to its manager; reading is allowed more widely than changing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Access {
    /// Listing, status, journal and path checks.
    Read,
    /// Unit actions, daemon-reload and linger.
    Manage,
}

/// The manager a request reaches, resolved and authorized.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Manager {
    System,
    /// A user's manager. `switch_user` is set when a root agent acts for another account, so
    /// the child runs with that account's UID and GID to reach its manager.
    User {
        account: Account,
        switch_user: bool,
    },
}

impl Manager {
    /// Resolves a requested scope and applies the trust rules: root may do anything; other
    /// agents may read the system manager and manage only their own user's manager.
    pub(super) async fn resolve(
        scope: &SystemdScope,
        access: Access,
        agent: &AgentAccount,
    ) -> Result<Self, CommandError> {
        let manager = match scope {
            SystemdScope::System => Self::System,
            SystemdScope::User { name } => {
                let account = Account::by_name(name).await?;
                let switch_user = account.uid != agent.account.uid;
                Self::User {
                    account,
                    switch_user,
                }
            }
        };
        manager.authorize(access, agent)?;
        Ok(manager)
    }

    /// Refuses what the agent's account may not do, before any child process runs.
    pub(super) fn authorize(
        &self,
        access: Access,
        agent: &AgentAccount,
    ) -> Result<(), CommandError> {
        if agent.is_root {
            return Ok(());
        }
        match self {
            Self::System if access == Access::Read => Ok(()),
            Self::System => Err(CommandError::new(
                CommandErrorKind::PermissionDenied,
                format!(
                    "The agent runs as {} and can only read system units; managing them requires the agent to run as root",
                    agent.account.name
                ),
            )),
            Self::User {
                switch_user: false, ..
            } => Ok(()),
            Self::User { account, .. } => Err(CommandError::new(
                CommandErrorKind::PermissionDenied,
                format!(
                    "The agent runs as {} and cannot reach the units of user {}; that requires the agent to run as root",
                    agent.account.name, account.name
                ),
            )),
        }
    }

    /// Whether the agent may act on this manager, for the UI's read-only views.
    pub(super) fn can_manage(&self, agent: &AgentAccount) -> bool {
        self.authorize(Access::Manage, agent).is_ok()
    }

    /// The scope this manager answers for.
    pub(super) fn scope(&self) -> SystemdScope {
        match self {
            Self::System => SystemdScope::System,
            Self::User { account, .. } => SystemdScope::User {
                name: account.name.clone(),
            },
        }
    }

    /// Fails with a typed error when a user's manager does not run, so the UI can offer to
    /// enable linger instead of showing a bus connection error.
    pub(super) async fn require_running(&self) -> Result<(), CommandError> {
        match self {
            Self::System => Ok(()),
            Self::User { account, .. } if account.manager_running().await => Ok(()),
            Self::User { account, .. } => Err(user_manager_not_running(&account.name)),
        }
    }
}

/// Whether a user manager runs in `runtime_dir`, judged by its private socket or the user bus
/// it starts. Checking files avoids starting a `systemctl` that would only time out. The
/// directory alone is not enough: logind creates it before the manager is up and keeps it
/// while the manager stops, so every place that reports or requires a running manager must
/// use this one check to agree with each other.
pub(super) async fn manager_sockets_exist(runtime_dir: &Path) -> bool {
    for socket in [runtime_dir.join("systemd/private"), runtime_dir.join("bus")] {
        if tokio::fs::try_exists(&socket).await.unwrap_or(false) {
            return true;
        }
    }
    false
}

/// The typed failure for a user manager that does not run.
pub(super) fn user_manager_not_running(name: &str) -> CommandError {
    CommandError::new(
        CommandErrorKind::SystemdUserManagerNotRunning,
        format!(
            "The systemd user manager of {name} is not running; it starts when {name} logs in, or at boot when linger is enabled"
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A test account with a fixed UID.
    fn account(name: &str, uid: u32) -> Account {
        Account {
            name: name.to_string(),
            uid,
            gid: uid,
            home: PathBuf::from(format!("/home/{name}")),
        }
    }

    /// The agent running as `name`.
    fn agent(name: &str, uid: u32) -> AgentAccount {
        AgentAccount {
            account: account(name, uid),
            is_root: uid == 0,
        }
    }

    /// A user manager as `agent` would resolve it.
    fn user_manager(agent: &AgentAccount, target: &Account) -> Manager {
        Manager::User {
            account: target.clone(),
            switch_user: target.uid != agent.account.uid,
        }
    }

    /// Verifies ordinary, instance and template unit names pass.
    #[test]
    fn accepts_real_unit_names() {
        for name in [
            "nginx.service",
            "getty@tty1.service",
            "getty@.service",
            "-.mount",
            "dev-disk-by\\x2duuid-1234.device",
            "user@1000.service",
            "systemd-fsck@dev-sda1.service",
            "app-t3code.slice",
        ] {
            let result = validate_unit_name(name);
            // Names systemd itself uses, the root mount included, must stay addressable.
            assert!(result.is_ok(), "{name}: {result:?}");
        }
    }

    /// Verifies names that could become options, globs or paths are refused.
    #[test]
    fn rejects_dangerous_or_malformed_unit_names() {
        for name in [
            "",
            "--now",
            ".service",
            "nginx",
            "nginx.conf",
            "*.service",
            "ngin?.service",
            "a[b].service",
            "a b.service",
            "../x.service",
            "a/b.service",
            "@x.service",
            "a@b@c.service",
            "a\nb.service",
        ] {
            // Each would either widen `journalctl -u` into a glob, act as a path, or is no
            // unit at all.
            assert_eq!(
                validate_unit_name(name).map_err(|error| error.kind),
                Err(CommandErrorKind::InvalidInput),
                "{name:?}"
            );
        }
        // A name longer than systemd's limit is refused before it reaches a process.
        assert!(validate_unit_name(&format!("{}.service", "a".repeat(250))).is_err());
    }

    /// Verifies template detection and type extraction.
    #[test]
    fn recognizes_templates_and_unit_types() {
        // Templates have no status, so details must treat them differently.
        assert!(is_template("getty@.service"));
        assert!(!is_template("getty@tty1.service"));
        assert!(!is_template("nginx.service"));
        // The list's type filter relies on the suffix.
        assert_eq!(unit_type("backup.timer"), "timer");
    }

    /// Verifies user names that could be options or paths are refused.
    #[test]
    fn rejects_dangerous_user_names() {
        for name in ["", "-root", "a/b", "a b", "a:b", "a\u{7}b"] {
            // These would reach `loginctl` as options or NSS as garbage.
            assert!(validate_user_name(name).is_err(), "{name:?}");
        }
        // Ordinary and service account names pass.
        assert!(validate_user_name("esa.matti_1").is_ok());
        assert!(validate_user_name("www-data").is_ok());
    }

    /// Verifies a root agent may read and manage every manager.
    #[test]
    fn root_may_manage_every_manager() {
        let root = agent("root", 0);
        let alice = account("alice", 1000);
        for manager in [
            Manager::System,
            user_manager(&root, &alice),
            user_manager(&root, &root.account),
        ] {
            for access in [Access::Read, Access::Manage] {
                // Root reaches other users' managers by switching to their UID.
                assert!(manager.authorize(access, &root).is_ok(), "{manager:?}");
            }
        }
        // Acting for another user runs the child as that user.
        assert!(matches!(
            user_manager(&root, &alice),
            Manager::User {
                switch_user: true,
                ..
            }
        ));
    }

    /// Verifies a non-root agent reads the system manager but cannot change it.
    #[test]
    fn non_root_system_scope_is_read_only() {
        let me = agent("me", 1000);
        // Listing, status and journal work without privileges.
        assert!(Manager::System.authorize(Access::Read, &me).is_ok());
        // Actions would only hit a polkit prompt nobody can answer, so they are refused here.
        assert_eq!(
            Manager::System
                .authorize(Access::Manage, &me)
                .map_err(|error| error.kind),
            Err(CommandErrorKind::PermissionDenied)
        );
        // The UI shows the system view read-only.
        assert!(!Manager::System.can_manage(&me));
    }

    /// Verifies a non-root agent fully manages its own user and nobody else's.
    #[test]
    fn non_root_manages_only_its_own_user() {
        let me = agent("me", 1000);
        let own = user_manager(&me, &me.account);
        let other = user_manager(&me, &account("bob", 1001));
        // The agent's own manager needs no privileges at all.
        assert!(own.authorize(Access::Manage, &me).is_ok());
        assert!(own.can_manage(&me));
        // Its own manager is reached without switching users.
        assert!(matches!(
            own,
            Manager::User {
                switch_user: false,
                ..
            }
        ));
        for access in [Access::Read, Access::Manage] {
            // Another user's manager cannot be reached without root, not even for reading.
            assert_eq!(
                other.authorize(access, &me).map_err(|error| error.kind),
                Err(CommandErrorKind::PermissionDenied)
            );
        }
    }

    /// Verifies unknown users are reported as missing rather than refused.
    #[tokio::test]
    async fn unknown_users_are_not_found() {
        let result = Account::by_name("redoor-no-such-user-xyz").await;
        // The UI tells a typo apart from a permission problem.
        assert_eq!(
            result.map_err(|error| error.kind),
            Err(CommandErrorKind::NotFound)
        );
    }
}
