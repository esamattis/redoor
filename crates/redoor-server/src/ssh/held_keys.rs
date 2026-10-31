//! Decrypted managed SSH keys the server holds while their devices are running.
//!
//! A `.redoorvault` file key normally lives only for one request. An encrypted SSH key
//! cannot work that way: the watchdog reconnects a device on its own (backoff, stale
//! heartbeats, overnight) long after the browser's Start request. So the browser hands the
//! key's file key over on Start, the server decrypts the key and keeps it here, in memory
//! only, until the device is stopped (Stop, device edit or deletion, key removal, supervisor
//! replacement) or the process exits. There is no handoff to a re-exec'd server: after any
//! restart every managed agent is `Stopped` anyway, and the next Start hands the key over
//! again.
//!
//! Locking the vault in the browser does not drop held keys, because that must not break
//! the reconnects of running devices. Access tokens cannot unlock the vault, but can start
//! a device whose key is still held.
//!
//! The map also records which account started each device, so the watchdog's reconnects
//! use that account's key and pin.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use redoor_protocol::ids::AgentId;

use super::keys::SshPrivateKey;

/// The held keys and the account that started each device. Cloned cheaply: every clone
/// shares one map.
#[derive(Clone, Default)]
pub(crate) struct HeldSshKeys {
    /// The shared state, behind a synchronous lock that is never held across an await.
    inner: Arc<Mutex<HeldState>>,
}

/// What [`HeldSshKeys`] guards.
#[derive(Default)]
struct HeldState {
    /// Decrypted keys by account and device.
    keys: HashMap<(String, AgentId), Arc<SshPrivateKey>>,
    /// The account whose Start made each device desired-running.
    started_by: HashMap<AgentId, String>,
}

impl HeldSshKeys {
    /// Locks the state; a poisoned lock still holds consistent maps, because every update
    /// is a single insert or remove.
    fn state(&self) -> std::sync::MutexGuard<'_, HeldState> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Holds `key` for the account's device until it is released.
    pub(crate) fn hold(&self, account: &str, device: &AgentId, key: Arc<SshPrivateKey>) {
        self.state()
            .keys
            .insert((account.to_string(), device.clone()), key);
    }

    /// The held key of the account's device, if any.
    pub(crate) fn get(&self, account: &str, device: &AgentId) -> Option<Arc<SshPrivateKey>> {
        self.state()
            .keys
            .get(&(account.to_string(), device.clone()))
            .cloned()
    }

    /// Drops the held key of the account's device.
    pub(crate) fn release(&self, account: &str, device: &AgentId) {
        self.state()
            .keys
            .remove(&(account.to_string(), device.clone()));
    }

    /// Drops every account's held key of a device and forgets who started it, because the
    /// device stopped or its configuration changed.
    pub(crate) fn release_device(&self, device: &AgentId) {
        let mut state = self.state();
        state
            .keys
            .retain(|(_, held_device), _| held_device != device);
        state.started_by.remove(device);
    }

    /// Records that `account` started the device, so its reconnects use that account's key
    /// and pin.
    pub(crate) fn record_start(&self, device: &AgentId, account: &str) {
        self.state()
            .started_by
            .insert(device.clone(), account.to_string());
    }

    /// The account that started the device, if it was started since the last release.
    pub(crate) fn started_by(&self, device: &AgentId) -> Option<String> {
        self.state().started_by.get(device).cloned()
    }

    /// Whether any key is held, for tests that check a request did not leave one behind.
    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.state().keys.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Releasing a device drops every account's key of it, but no other device's.
    #[test]
    fn release_device_drops_only_that_device() {
        let held = HeldSshKeys::default();
        let device = AgentId::generate();
        let other = AgentId::generate();
        let key = Arc::new(SshPrivateKey::generate().unwrap());
        held.hold("alice", &device, key.clone());
        held.hold("bob", &device, key.clone());
        held.hold("alice", &other, key);
        held.record_start(&device, "alice");

        held.release_device(&device);
        // Both accounts' keys of the stopped device are gone.
        assert!(held.get("alice", &device).is_none());
        assert!(held.get("bob", &device).is_none());
        // Who started it is forgotten, so a later start records it again.
        assert!(held.started_by(&device).is_none());
        // The other device keeps running with its key.
        assert!(held.get("alice", &other).is_some());
    }
}
