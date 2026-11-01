//! Decrypted managed SSH keys the server holds while their devices are running.
//!
//! A `.redoorencrypted` file key normally lives only for one request. An encrypted SSH key
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

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use redoor_protocol::ids::AgentId;

use super::keys::SshPrivateKey;

/// The held keys by device. Cloned cheaply: every clone shares one map.
#[derive(Clone, Default)]
pub(crate) struct HeldSshKeys {
    /// Decrypted keys by device, behind a synchronous lock that is never held across an
    /// await.
    keys: Arc<Mutex<HashMap<AgentId, Arc<SshPrivateKey>>>>,
}

impl HeldSshKeys {
    /// Locks the map; a poisoned lock still holds a consistent map, because every update is
    /// a single insert or remove.
    fn keys(&self) -> std::sync::MutexGuard<'_, HashMap<AgentId, Arc<SshPrivateKey>>> {
        self.keys
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Holds `key` for the device until it is released.
    pub(crate) fn hold(&self, device: &AgentId, key: Arc<SshPrivateKey>) {
        self.keys().insert(device.clone(), key);
    }

    /// The held key of the device, if any.
    pub(crate) fn get(&self, device: &AgentId) -> Option<Arc<SshPrivateKey>> {
        self.keys().get(device).cloned()
    }

    /// Drops the held key of the device, because it stopped, its configuration changed or
    /// its key was removed.
    pub(crate) fn release(&self, device: &AgentId) {
        self.keys().remove(device);
    }

    /// Whether any key is held, for tests that check a request did not leave one behind.
    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.keys().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Releasing a device drops its key, but no other device's.
    #[test]
    fn release_drops_only_that_device() {
        let held = HeldSshKeys::default();
        let device = AgentId::generate();
        let other = AgentId::generate();
        let key = Arc::new(SshPrivateKey::generate().unwrap());
        held.hold(&device, key.clone());
        held.hold(&other, key);

        held.release(&device);
        // The stopped device's key is gone.
        assert!(held.get(&device).is_none());
        // The other device keeps running with its key.
        assert!(held.get(&other).is_some());
    }
}
