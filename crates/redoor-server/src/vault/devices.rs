//! Device secrets that make the browser's vault idle lock real.
//!
//! A browser that unlocks the vault keeps the raw vault key in IndexedDB only encrypted with
//! a per-device secret, and that secret lives here, in server memory. The server hands it
//! out only to the login session that created it and only within the idle window the user
//! picked, and forgets it once the window has passed, the session ends or the server
//! restarts. So neither half opens anything alone: an expired entry leaves a copied browser
//! profile holding ciphertext that nobody can open, while the server still never sees a
//! vault key.
//!
//! Memory only on purpose: nothing secret is at rest on the server, and a restart locks every
//! browser.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use redoor_protocol::api::vault::{
    ApiErrorCode, CreateVaultDeviceResponse, OpenVaultDeviceResponse, VaultDeviceStatusResponse,
    VaultLockAfter,
};
use zeroize::Zeroizing;

use crate::http::error::ApiError;

/// Upper bound on stored entries, so a stolen session cookie cannot grow server memory
/// without bound by creating entries in a loop. Far above what one account's browsers need.
const MAX_DEVICES: usize = 50;

/// How often the background task drops expired entries and entries of ended sessions, so a
/// secret does not sit in memory until the next request touches the store.
const PRUNE_INTERVAL: Duration = Duration::from_secs(60);

/// The monotonic clock the store measures idle time with. Injected, so unit tests can move
/// time forward instead of sleeping; a server wall clock change cannot extend or cut a lock.
type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

/// One browser's device secret.
struct DeviceEntry {
    /// 32 random bytes, wiped when the entry is dropped and never logged.
    secret: Zeroizing<[u8; 32]>,
    lock_after: VaultLockAfter,
    /// The last vault use the browser reported. Opening on a page load does not move it, so
    /// reloading is not use.
    last_used_at: Instant,
    /// The login session that created the entry; only it may open or touch it.
    session_id: String,
}

impl DeviceEntry {
    /// Time left before the idle lock, `Some(None)` without an idle lock, `None` once
    /// expired.
    fn remaining(&self, now: Instant) -> Option<Option<Duration>> {
        match self.lock_after.idle_duration() {
            None => Some(None),
            Some(idle) => idle
                .checked_sub(now.saturating_duration_since(self.last_used_at))
                .filter(|remaining| !remaining.is_zero())
                .map(Some),
        }
    }
}

/// Whole seconds until the lock, rounded up so the browser never locks before the server
/// does by rounding alone.
fn expires_in_seconds(remaining: Option<Duration>) -> Option<u64> {
    remaining.map(|remaining| remaining.as_secs() + u64::from(remaining.subsec_nanos() > 0))
}

/// The account's device secrets. Cloned cheaply: every clone shares one map.
#[derive(Clone)]
pub(crate) struct VaultDeviceStore {
    /// Entries by device id, behind a synchronous lock that is never held across an await.
    devices: Arc<Mutex<HashMap<String, DeviceEntry>>>,
    clock: Clock,
}

impl Default for VaultDeviceStore {
    /// A store on the real monotonic clock.
    fn default() -> Self {
        Self::with_clock(Arc::new(Instant::now))
    }
}

impl VaultDeviceStore {
    /// A store measuring idle time with `clock`, for tests.
    fn with_clock(clock: Clock) -> Self {
        Self {
            devices: Arc::default(),
            clock,
        }
    }

    /// Locks the map, after dropping expired entries, so no access ever sees one. A
    /// poisoned lock still holds a consistent map, because every update is a single insert,
    /// remove or field write.
    fn devices(&self) -> std::sync::MutexGuard<'_, HashMap<String, DeviceEntry>> {
        let now = (self.clock)();
        let mut devices = self
            .devices
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        devices.retain(|_, entry| entry.remaining(now).is_some());
        devices
    }

    /// Creates an entry for the session with a fresh secret. At the cap, the least recently
    /// used entry goes, whichever session it belongs to.
    pub(crate) fn create(
        &self,
        session_id: &str,
        lock_after: VaultLockAfter,
    ) -> CreateVaultDeviceResponse {
        let mut secret = Zeroizing::new([0u8; 32]);
        getrandom::fill(secret.as_mut()).expect("operating system random source");
        let device_id = redoor_vault::random_base64url(16);
        let encoded_secret = redoor_vault::encode_base64url(secret.as_ref());
        let now = (self.clock)();
        let mut devices = self.devices();
        while devices.len() >= MAX_DEVICES {
            let Some(oldest) = devices
                .iter()
                .min_by_key(|(_, entry)| entry.last_used_at)
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            devices.remove(&oldest);
        }
        devices.insert(
            device_id.clone(),
            DeviceEntry {
                secret,
                lock_after,
                last_used_at: now,
                session_id: session_id.to_string(),
            },
        );
        CreateVaultDeviceResponse {
            device_id,
            secret: encoded_secret,
            expires_in_seconds: expires_in_seconds(lock_after.idle_duration()),
        }
    }

    /// Hands the secret back to the session that created it, without counting as use.
    pub(crate) fn open(
        &self,
        device_id: &str,
        session_id: &str,
    ) -> Result<OpenVaultDeviceResponse, ApiError> {
        let now = (self.clock)();
        let devices = self.devices();
        let entry = owned_entry(&devices, device_id, session_id)?;
        Ok(OpenVaultDeviceResponse {
            secret: redoor_vault::encode_base64url(entry.secret.as_ref()),
            expires_in_seconds: expires_in_seconds(entry.remaining(now).flatten()),
        })
    }

    /// Records a vault use, restarting the idle window.
    pub(crate) fn touch(
        &self,
        device_id: &str,
        session_id: &str,
    ) -> Result<VaultDeviceStatusResponse, ApiError> {
        let now = (self.clock)();
        let mut devices = self.devices();
        let entry = devices
            .get_mut(device_id)
            .filter(|entry| entry.session_id == session_id)
            .ok_or_else(device_not_found)?;
        entry.last_used_at = now;
        Ok(VaultDeviceStatusResponse {
            expires_in_seconds: expires_in_seconds(entry.lock_after.idle_duration()),
        })
    }

    /// Whether the entry still opens and for how long, without counting as use, so open
    /// tabs can notice a lost entry and lock themselves.
    pub(crate) fn status(
        &self,
        device_id: &str,
        session_id: &str,
    ) -> Result<VaultDeviceStatusResponse, ApiError> {
        let now = (self.clock)();
        let devices = self.devices();
        let entry = owned_entry(&devices, device_id, session_id)?;
        Ok(VaultDeviceStatusResponse {
            expires_in_seconds: expires_in_seconds(entry.remaining(now).flatten()),
        })
    }

    /// Deletes the session's entry, for "Lock now". Idempotent, and another session's entry
    /// is left alone, so a stolen cookie of one session cannot lock another browser.
    pub(crate) fn delete(&self, device_id: &str, session_id: &str) {
        let mut devices = self.devices();
        if devices
            .get(device_id)
            .is_some_and(|entry| entry.session_id == session_id)
        {
            devices.remove(device_id);
        }
    }

    /// Deletes every entry of a session, because it signed out: the vault never outlasts the
    /// login session, even when the page could not lock it itself.
    pub(crate) fn delete_session(&self, session_id: &str) {
        self.devices()
            .retain(|_, entry| entry.session_id != session_id);
    }

    /// Deletes every entry, because a rotation or backup restore replaced the generation
    /// every stored raw key belongs to.
    pub(crate) fn clear(&self) {
        self.devices().clear();
    }

    /// The sessions that own entries, for the prune task to check without holding the lock.
    fn session_ids(&self) -> Vec<String> {
        let mut sessions: Vec<String> = self
            .devices()
            .values()
            .map(|entry| entry.session_id.clone())
            .collect();
        sessions.sort_unstable();
        sessions.dedup();
        sessions
    }

    /// Drops expired entries and the entries of sessions that ended (signed out elsewhere,
    /// expired, or revoked by a password or config change), so their secrets leave memory
    /// within a prune interval.
    pub(crate) async fn prune(&self, auth: &crate::http::auth::AuthState) {
        for session_id in self.session_ids() {
            if matches!(
                auth.check_session_id(&session_id).await,
                crate::http::auth::SessionCheck::Invalid
            ) {
                self.delete_session(&session_id);
            }
        }
    }

    /// Runs [`Self::prune`] every [`PRUNE_INTERVAL`] for the life of the server. One task per
    /// server, not per request, so a plain `tokio::spawn` is right.
    pub(crate) fn spawn_prune_task(&self, auth: crate::http::auth::AuthState) {
        let store = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(PRUNE_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                store.prune(&auth).await;
            }
        });
    }
}

/// The entry of `device_id` if `session_id` owns it. Missing, expired and foreign entries
/// get the same answer, so a session cannot probe for other sessions' ids.
fn owned_entry<'a>(
    devices: &'a HashMap<String, DeviceEntry>,
    device_id: &str,
    session_id: &str,
) -> Result<&'a DeviceEntry, ApiError> {
    devices
        .get(device_id)
        .filter(|entry| entry.session_id == session_id)
        .ok_or_else(device_not_found)
}

/// The browser's entry is gone; it forgets its wrapped key and stays locked.
fn device_not_found() -> ApiError {
    ApiError::coded(
        StatusCode::NOT_FOUND,
        ApiErrorCode::VaultDeviceNotFound,
        "The vault was locked on this browser; unlock it again",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A clock the test moves by hand.
    #[derive(Clone)]
    struct ManualClock(Arc<Mutex<Instant>>);

    impl ManualClock {
        fn new() -> Self {
            Self(Arc::new(Mutex::new(Instant::now())))
        }

        fn advance(&self, by: Duration) {
            *self.0.lock().unwrap() += by;
        }

        fn store(&self) -> VaultDeviceStore {
            let clock = self.clone();
            VaultDeviceStore::with_clock(Arc::new(move || *clock.0.lock().unwrap()))
        }
    }

    const SESSION: &str = "session-a";
    const OTHER_SESSION: &str = "session-b";

    /// Asserts that the result is the device-not-found answer.
    fn assert_not_found<T>(result: Result<T, ApiError>) {
        match result {
            Ok(_) => panic!("expected vault_device_not_found"),
            Err(error) => assert_eq!(error.code(), Some(ApiErrorCode::VaultDeviceNotFound)),
        }
    }

    /// Every idle choice expires exactly at its duration, and not a moment before.
    #[test]
    fn each_choice_expires_after_its_idle_time() {
        for lock_after in [
            VaultLockAfter::FifteenMinutes,
            VaultLockAfter::OneHour,
            VaultLockAfter::TwentyFourHours,
            VaultLockAfter::OneWeek,
        ] {
            let clock = ManualClock::new();
            let store = clock.store();
            let idle = lock_after.idle_duration().unwrap();
            let created = store.create(SESSION, lock_after);
            // The browser learns the full window right away.
            assert_eq!(created.expires_in_seconds, Some(idle.as_secs()));

            clock.advance(idle - Duration::from_secs(1));
            let opened = store.open(&created.device_id, SESSION).unwrap();
            // Just before the deadline the same secret still comes back, with one second left.
            assert_eq!(opened.secret, created.secret, "{lock_after:?}");
            assert_eq!(opened.expires_in_seconds, Some(1));

            clock.advance(Duration::from_secs(1));
            // At the deadline the secret is gone for good.
            assert_not_found(store.open(&created.device_id, SESSION));
        }
    }

    /// `never` has no idle lock at all.
    #[test]
    fn never_does_not_expire() {
        let clock = ManualClock::new();
        let store = clock.store();
        let created = store.create(SESSION, VaultLockAfter::Never);
        // No deadline is reported to the browser.
        assert_eq!(created.expires_in_seconds, None);
        clock.advance(Duration::from_secs(400 * 24 * 60 * 60));
        // A year later the secret still opens, with no deadline.
        let opened = store.open(&created.device_id, SESSION).unwrap();
        assert_eq!(opened.expires_in_seconds, None);
    }

    /// Opening on a page load is not use, so reloading cannot keep the vault unlocked, while
    /// touching restarts the idle window.
    #[test]
    fn open_keeps_the_deadline_and_touch_extends_it() {
        let clock = ManualClock::new();
        let store = clock.store();
        let created = store.create(SESSION, VaultLockAfter::FifteenMinutes);

        clock.advance(Duration::from_secs(10 * 60));
        let opened = store.open(&created.device_id, SESSION).unwrap();
        // Ten minutes in, five remain; the open did not reset them.
        assert_eq!(opened.expires_in_seconds, Some(5 * 60));
        let status = store.status(&created.device_id, SESSION).unwrap();
        // The status check does not reset them either.
        assert_eq!(status.expires_in_seconds, Some(5 * 60));

        let touched = store.touch(&created.device_id, SESSION).unwrap();
        // A touch restarts the full window.
        assert_eq!(touched.expires_in_seconds, Some(15 * 60));
        clock.advance(Duration::from_secs(10 * 60));
        // So ten more minutes later the entry still opens, measured from the touch.
        assert_eq!(
            store
                .open(&created.device_id, SESSION)
                .unwrap()
                .expires_in_seconds,
            Some(5 * 60)
        );
        clock.advance(Duration::from_secs(5 * 60));
        // And it expires fifteen minutes after the touch.
        assert_not_found(store.status(&created.device_id, SESSION));
        assert_not_found(store.touch(&created.device_id, SESSION));
    }

    /// Expired entries leave memory on the next access of any kind, not only when their own
    /// id is asked for.
    #[test]
    fn any_access_prunes_expired_entries() {
        let clock = ManualClock::new();
        let store = clock.store();
        let short = store.create(SESSION, VaultLockAfter::FifteenMinutes);
        let long = store.create(SESSION, VaultLockAfter::Never);
        clock.advance(Duration::from_secs(15 * 60));

        store.status(&long.device_id, SESSION).unwrap();
        // Checking another entry already dropped the expired one from the map.
        assert!(!store.devices.lock().unwrap().contains_key(&short.device_id));
        // The entry without an idle lock stays.
        assert_eq!(store.session_ids(), vec![SESSION.to_string()]);
    }

    /// Only the session that created an entry may use it; other sessions get the same 404 as
    /// for a missing entry, and cannot delete it.
    #[test]
    fn other_sessions_are_refused() {
        let store = ManualClock::new().store();
        let created = store.create(SESSION, VaultLockAfter::OneHour);

        // Another session cannot read the secret, use it or check it.
        assert_not_found(store.open(&created.device_id, OTHER_SESSION));
        assert_not_found(store.touch(&created.device_id, OTHER_SESSION));
        assert_not_found(store.status(&created.device_id, OTHER_SESSION));
        store.delete(&created.device_id, OTHER_SESSION);
        // Its delete was ignored, so the owner still opens the entry.
        store.open(&created.device_id, SESSION).unwrap();

        store.delete(&created.device_id, SESSION);
        // The owner's delete removes it, and repeating it is harmless.
        assert_not_found(store.open(&created.device_id, SESSION));
        store.delete(&created.device_id, SESSION);
    }

    /// Signing out deletes only that session's entries.
    #[test]
    fn deleting_a_session_keeps_other_sessions() {
        let store = ManualClock::new().store();
        let mine = store.create(SESSION, VaultLockAfter::Never);
        let theirs = store.create(OTHER_SESSION, VaultLockAfter::Never);

        store.delete_session(SESSION);
        // The signed-out session's browser is locked.
        assert_not_found(store.open(&mine.device_id, SESSION));
        // The other session's browser is not.
        store.open(&theirs.device_id, OTHER_SESSION).unwrap();
    }

    /// Creating past the cap drops the least recently used entry, so memory stays bounded.
    #[test]
    fn the_cap_drops_the_least_recently_used_entry() {
        let clock = ManualClock::new();
        let store = clock.store();
        let first = store.create(SESSION, VaultLockAfter::Never);
        clock.advance(Duration::from_secs(1));
        let second = store.create(SESSION, VaultLockAfter::Never);
        for _ in 2..MAX_DEVICES {
            clock.advance(Duration::from_secs(1));
            store.create(SESSION, VaultLockAfter::Never);
        }
        clock.advance(Duration::from_secs(1));
        // Using the oldest entry makes the second one the least recently used.
        store.touch(&first.device_id, SESSION).unwrap();

        store.create(SESSION, VaultLockAfter::Never);
        // The map never grows past the cap.
        assert_eq!(store.devices.lock().unwrap().len(), MAX_DEVICES);
        // The least recently used entry went.
        assert_not_found(store.open(&second.device_id, SESSION));
        // The one used recently stayed, even though it was created first.
        store.open(&first.device_id, SESSION).unwrap();
    }

    /// Rotation and backup restore replace the generation every stored key belongs to, so
    /// every browser's entry goes.
    #[test]
    fn clear_removes_every_session_entry() {
        let store = ManualClock::new().store();
        let mine = store.create(SESSION, VaultLockAfter::Never);
        let theirs = store.create(OTHER_SESSION, VaultLockAfter::OneWeek);

        store.clear();
        // Neither browser can open its wrapped key anymore.
        assert_not_found(store.open(&mine.device_id, SESSION));
        assert_not_found(store.open(&theirs.device_id, OTHER_SESSION));
    }

    /// The prune task drops entries of sessions that ended and keeps those of live ones.
    #[tokio::test]
    async fn prune_drops_entries_of_ended_sessions() {
        let (_directory, auth, session) = crate::http::auth::test_support::signed_in_auth().await;
        let store = ManualClock::new().store();
        let live = store.create(&session.id, VaultLockAfter::Never);
        // A well-formed session id without a session file stands for an ended session.
        let ended_session = uuid::Uuid::new_v4().to_string();
        let ended = store.create(&ended_session, VaultLockAfter::Never);

        store.prune(&auth).await;
        // The ended session's secret left memory.
        assert_not_found(store.open(&ended.device_id, &ended_session));
        // The live session's secret stayed.
        store.open(&live.device_id, &session.id).unwrap();

        auth.delete_session_id(&session.id).await.unwrap();
        store.prune(&auth).await;
        // Once that session ends too, its secret goes on the next prune.
        assert_not_found(store.open(&live.device_id, &session.id));
    }
}
