//! Durable principal-owned operation lifecycle and quota-bounded command output.
//!
//! Each command pipe (stdout, stderr) is spooled to its own file holding the decoded bytes.
//! A spool keeps the head of the pipe's output and a rolling tail of its newest bytes, so
//! errors at the end of a long output survive truncation while disk use stays bounded.

use anyhow::{Context, Result};
use jiff::Timestamp;
use redoor_core::log;
use redoor_protocol::wire::log::Level;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    ops::Range,
    path::{Path, PathBuf},
    sync::{Arc, Weak},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::Mutex,
};
use uuid::Uuid;

/// Default retained output per operation, keeping one chatty command from filling the store.
const DEFAULT_JOB_QUOTA: usize = 1024 * 1024;
/// Default retained output across all operations, bounding total disk use.
const DEFAULT_GLOBAL_QUOTA: usize = 64 * 1024 * 1024;
/// Default age after which finished operations are dropped so history does not grow forever.
const DEFAULT_EXPIRY_SECONDS: u64 = 24 * 60 * 60;
/// File name of the metadata document inside the operation directory.
const METADATA_FILE: &str = "operations.json";
/// Prefix of the metadata document's temporary replacement files; a UUID follows, so the
/// startup sweep can recognize leftovers of a crash without touching unrelated files.
const METADATA_TEMP_PREFIX: &str = "operations.tmp-";

/// One output pipe of a command; each has its own spool, budget and paging offset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Pipe {
    Stdout,
    Stderr,
}

impl Pipe {
    /// Both pipes in the order responses list them.
    pub(super) const ALL: [Pipe; 2] = [Pipe::Stdout, Pipe::Stderr];

    /// Name used in tool arguments, responses and spool file names.
    pub(super) fn name(self) -> &'static str {
        match self {
            Pipe::Stdout => "stdout",
            Pipe::Stderr => "stderr",
        }
    }

    /// File name suffix after `<operation id>.`, which the startup sweep matches exactly.
    fn spool_suffix(self) -> &'static str {
        match self {
            Pipe::Stdout => "stdout.spool",
            Pipe::Stderr => "stderr.spool",
        }
    }
}

/// Head and tail sizes of one pipe's spool, derived from the operation's retention limit.
#[derive(Clone, Copy, Debug)]
struct PipeBudget {
    head: u64,
    tail: u64,
}

impl PipeBudget {
    /// Splits an operation's limit evenly between its two pipes, and each pipe's share evenly
    /// between head and tail, so the operation never exceeds its limit whatever it prints.
    fn for_limit(limit: u64) -> Self {
        let pipe = limit / 2;
        let head = pipe / 2;
        Self {
            head,
            tail: pipe - head,
        }
    }
}

/// Where one pipe's retained bytes are in its spool file.
///
/// The file holds the head at `[0, head)` and a ring of the newest bytes after it at
/// `[head, head + ring)`. The ring's oldest byte is at ring index `ring_start`, so the tail
/// in output order is `ring[ring_start..] + ring[..ring_start]`. Everything the pipe wrote
/// between the head and the tail is omitted, which keeps the gap in one place.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct SpoolState {
    /// Bytes the pipe wrote, retained or not.
    pub(super) total: u64,
    /// Bytes kept from the start of the output.
    pub(super) head: u64,
    /// Whether the head stopped growing; later bytes only ever go to the tail ring.
    pub(super) head_closed: bool,
    /// Bytes in the tail ring; also its capacity once it wrapped.
    pub(super) ring: u64,
    /// Ring index of the oldest tail byte; zero until the ring wraps.
    pub(super) ring_start: u64,
}

/// One positioned write a [`SpoolState::plan`] asks for.
#[derive(Debug, PartialEq, Eq)]
struct SpoolWrite {
    /// Byte offset in the spool file.
    file_offset: u64,
    /// The part of the appended data to write there.
    data: Range<usize>,
}

impl SpoolState {
    /// Bytes on disk, which is also what a reader can page through.
    pub(super) fn retained(&self) -> u64 {
        self.head + self.ring
    }

    /// Bytes the pipe wrote between the head and the tail that were not kept.
    pub(super) fn omitted(&self) -> u64 {
        self.total.saturating_sub(self.retained())
    }

    /// Accounts `len` new bytes and returns the writes that keep the head and tail current.
    ///
    /// `growth` is how many more bytes the global quota lets the spool grow; the plan takes
    /// what it uses from it. Once the head or the ring cannot grow, the bytes still roll
    /// through the ring that was already granted, so a full quota keeps the newest output
    /// without using more disk.
    fn plan(&mut self, len: usize, budget: PipeBudget, growth: &mut u64) -> Vec<SpoolWrite> {
        let mut writes = Vec::new();
        self.total += len as u64;
        let mut position = 0usize;
        if !self.head_closed {
            let wanted = budget.head.saturating_sub(self.head).min(len as u64);
            let granted = wanted.min(*growth);
            if granted > 0 {
                writes.push(SpoolWrite {
                    file_offset: self.head,
                    data: 0..granted as usize,
                });
                self.head += granted;
                *growth -= granted;
                position = granted as usize;
            }
            // A refused grant closes the head as well, so the tail starts right after what was
            // kept and the omitted bytes stay one contiguous gap.
            if self.head >= budget.head || granted < wanted {
                self.head_closed = true;
            }
        }
        if position == len {
            return writes;
        }
        // Appending keeps output order only while the ring has not wrapped.
        if self.ring_start == 0 {
            let wanted = budget
                .tail
                .saturating_sub(self.ring)
                .min((len - position) as u64);
            let granted = wanted.min(*growth);
            if granted > 0 {
                writes.push(SpoolWrite {
                    file_offset: self.head + self.ring,
                    data: position..position + granted as usize,
                });
                self.ring += granted;
                *growth -= granted;
                position += granted as usize;
            }
        }
        let remaining = (len - position) as u64;
        if remaining == 0 || self.ring == 0 {
            return writes;
        }
        if remaining >= self.ring {
            // The new bytes replace the whole ring, so only its newest bytes are written, in order.
            writes.push(SpoolWrite {
                file_offset: self.head,
                data: len - self.ring as usize..len,
            });
            self.ring_start = 0;
        } else {
            let first = (self.ring - self.ring_start).min(remaining) as usize;
            writes.push(SpoolWrite {
                file_offset: self.head + self.ring_start,
                data: position..position + first,
            });
            if position + first < len {
                writes.push(SpoolWrite {
                    file_offset: self.head,
                    data: position + first..len,
                });
            }
            self.ring_start = (self.ring_start + remaining) % self.ring;
        }
        writes
    }

    /// Maps the retained output range `[start, end)` to contiguous `(file offset, length)`
    /// pieces, unrolling the ring so callers read the bytes in output order.
    fn file_ranges(&self, start: u64, end: u64) -> Vec<(u64, u64)> {
        let mut ranges = Vec::new();
        if start < self.head {
            ranges.push((start, end.min(self.head) - start));
        }
        if end > self.head && self.ring > 0 {
            let mut logical = start.max(self.head) - self.head;
            let logical_end = end - self.head;
            while logical < logical_end {
                let physical = (self.ring_start + logical) % self.ring;
                let length = (self.ring - physical).min(logical_end - logical);
                ranges.push((self.head + physical, length));
                logical += length;
            }
        }
        ranges
    }

    /// The state after `len` more bytes whose write may have damaged the ring: the head is
    /// kept, and the ring and the new bytes count as omitted. The head closes, so later
    /// output starts a fresh ring after the gap.
    fn dropping_ring(&self, len: usize) -> Self {
        Self {
            total: self.total + len as u64,
            head: self.head,
            head_closed: true,
            ring: 0,
            ring_start: 0,
        }
    }

    /// Shrinks the recorded state to what a spool file of `len` bytes can actually hold.
    ///
    /// A crash can leave the file shorter than the last persisted state (the record was saved
    /// before the bytes reached disk). A partial ring has lost its order, so it is dropped;
    /// the dropped bytes then count as omitted.
    fn clamp_to(&mut self, len: u64) {
        if len < self.retained() {
            self.head = self.head.min(len);
            self.ring = 0;
            self.ring_start = 0;
        }
    }
}

/// One retained operation is addressable only through the access token that admitted it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct OperationRecord {
    pub(super) id: Uuid,
    pub(super) owner_token: Uuid,
    pub(super) device_ids: Vec<String>,
    pub(super) kind: String,
    pub(super) state: String,
    pub(super) stdout: SpoolState,
    pub(super) stderr: SpoolState,
    pub(super) terminal: Option<Value>,
    pub(super) remote_id: Option<u64>,
    pub(super) cancel_requested: bool,
    pub(super) created_at: Timestamp,
    pub(super) updated_at: Timestamp,
}

impl OperationRecord {
    /// The spool state of one pipe, so callers can treat both pipes uniformly.
    pub(super) fn spool(&self, pipe: Pipe) -> &SpoolState {
        match pipe {
            Pipe::Stdout => &self.stdout,
            Pipe::Stderr => &self.stderr,
        }
    }

    /// Whether the operation may still change, which also protects it from expiry.
    pub(super) fn is_active(&self) -> bool {
        matches!(self.state.as_str(), "admitted" | "running" | "canceling")
    }
}

/// Idempotency entries bind a principal key to the complete normalized mutation.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct IdempotencyRecord {
    fingerprint: String,
    result: Value,
}

/// The durable document keeps admissions and retry decisions across server restarts.
#[derive(Default, Serialize, Deserialize)]
struct PersistedOperations {
    records: Vec<OperationRecord>,
    idempotency: HashMap<String, IdempotencyRecord>,
}

impl PersistedOperations {
    /// Reads the metadata document, discarding whatever no longer parses instead of failing
    /// startup: records written by an older format are dropped one by one, and their spools
    /// become orphans for the startup sweep.
    async fn load(path: &Path) -> Result<Self> {
        let bytes = match tokio::fs::read(path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default());
            }
            Err(error) => return Err(error).context("reading MCP operation metadata"),
        };
        let document: Value = match serde_json::from_slice(&bytes) {
            Ok(document) => document,
            Err(error) => {
                log!(
                    Level::Warning,
                    "Discarding unreadable MCP operation metadata: {error}"
                );
                return Ok(Self::default());
            }
        };
        let records = document
            .get("records")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|record| match serde_json::from_value(record.clone()) {
                Ok(record) => Some(record),
                Err(error) => {
                    log!(
                        Level::Warning,
                        "Discarding unreadable MCP operation record: {error}"
                    );
                    None
                }
            })
            .collect();
        let idempotency = document
            .get("idempotency")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter_map(|(key, entry)| {
                serde_json::from_value(entry.clone())
                    .ok()
                    .map(|entry| (key.clone(), entry))
            })
            .collect();
        Ok(Self {
            records,
            idempotency,
        })
    }
}

/// Process-local locks protect a durable single-server operation registry.
#[derive(Clone)]
pub(super) struct OperationRegistry {
    records: Arc<Mutex<HashMap<Uuid, Arc<Mutex<OperationRecord>>>>>,
    idempotency: Arc<Mutex<HashMap<String, IdempotencyRecord>>>,
    admission_locks: Arc<Mutex<HashMap<String, Weak<Mutex<()>>>>>,
    directory: Arc<PathBuf>,
    metadata_path: Arc<PathBuf>,
    /// Serializes spool reads and writes, so a reader never sees a ring mid-update, and holds
    /// the bytes all spools use on disk, which the global quota is checked against.
    spool_usage: Arc<Mutex<u64>>,
    /// Serializes metadata replacement so an older snapshot never overwrites a newer one.
    persist_lock: Arc<Mutex<()>>,
    per_job_quota: usize,
    global_quota: usize,
    expiry: Duration,
}

impl OperationRegistry {
    /// Loads durable admissions from the given directory, marks unacknowledged work
    /// interrupted, and reconciles the spools on disk with the records; tests pass an
    /// isolated directory.
    pub(super) async fn in_directory(directory: PathBuf) -> Result<Self> {
        tokio::fs::create_dir_all(&directory)
            .await
            .context("creating MCP operation directory")?;
        #[cfg(unix)]
        tokio::fs::set_permissions(
            &directory,
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )
        .await
        .context("protecting MCP operation directory")?;
        let metadata_path = directory.join(METADATA_FILE);
        let persisted = PersistedOperations::load(&metadata_path).await?;
        let expiry = Duration::from_secs(environment_usize(
            "REDOOR_MCP_OPERATION_EXPIRY_SECONDS",
            DEFAULT_EXPIRY_SECONDS as usize,
        ) as u64);
        let cutoff = Timestamp::now().checked_sub(expiry)?;
        let mut records = HashMap::new();
        let mut usage = 0u64;
        for mut record in persisted.records {
            if record.updated_at < cutoff {
                continue;
            }
            // Router counters belong to one process and must never survive recovery.
            record.remote_id = None;
            if record.is_active() {
                // A ring that stopped growing is overwritten in place, and a write that
                // reached disk after the last persist leaves no trace in the file length.
                // Whether it had stopped depends on the quota at the time, which is not
                // recorded, so the ring of interrupted work is dropped; its bytes become
                // omitted, and adopting the spool trims the file back to the head.
                for state in [&mut record.stdout, &mut record.stderr] {
                    state.ring = 0;
                    state.ring_start = 0;
                }
                record.state = "interrupted".to_string();
                record.terminal = Some(
                    serde_json::json!({"reason":"server_restarted_before_terminal_acknowledgement"}),
                );
                record.updated_at = Timestamp::now();
            }
            for pipe in Pipe::ALL {
                let path = spool_path(&directory, record.id, pipe);
                let state = match pipe {
                    Pipe::Stdout => &mut record.stdout,
                    Pipe::Stderr => &mut record.stderr,
                };
                usage += adopt_spool(&path, state).await?;
            }
            records.insert(record.id, Arc::new(Mutex::new(record)));
        }
        let live = records.keys().copied().collect::<HashSet<_>>();
        sweep_orphans(&directory, &live).await?;
        let registry = Self {
            records: Arc::new(Mutex::new(records)),
            idempotency: Arc::new(Mutex::new(persisted.idempotency)),
            admission_locks: Arc::default(),
            directory: Arc::new(directory),
            metadata_path: Arc::new(metadata_path),
            spool_usage: Arc::new(Mutex::new(usage)),
            persist_lock: Arc::default(),
            per_job_quota: environment_usize("REDOOR_MCP_OPERATION_JOB_QUOTA", DEFAULT_JOB_QUOTA),
            global_quota: environment_usize(
                "REDOOR_MCP_OPERATION_GLOBAL_QUOTA",
                DEFAULT_GLOBAL_QUOTA,
            ),
            expiry,
        };
        registry.persist().await?;
        Ok(registry)
    }

    /// Returns the configured hard ceiling for one command's retained output.
    pub(super) fn per_job_quota(&self) -> usize {
        self.per_job_quota
    }

    /// Creates and durably records admission before the caller starts remote work.
    pub(super) async fn create(
        &self,
        owner_token: Uuid,
        device_ids: Vec<String>,
        kind: impl Into<String>,
    ) -> Result<Arc<Mutex<OperationRecord>>> {
        self.expire().await?;
        let id = Uuid::new_v4();
        let now = Timestamp::now();
        let record = Arc::new(Mutex::new(OperationRecord {
            id,
            owner_token,
            device_ids,
            kind: kind.into(),
            state: "admitted".to_string(),
            stdout: SpoolState::default(),
            stderr: SpoolState::default(),
            terminal: None,
            remote_id: None,
            cancel_requested: false,
            created_at: now,
            updated_at: now,
        }));
        self.records.lock().await.insert(id, record.clone());
        self.persist().await?;
        Ok(record)
    }

    /// Looks up an unexpired operation without disclosing ownership.
    pub(super) async fn get(&self, id: Uuid) -> Result<Option<Arc<Mutex<OperationRecord>>>> {
        self.expire().await?;
        Ok(self.records.lock().await.get(&id).cloned())
    }

    /// Persists state transitions after a remote acknowledgement or cancellation request.
    pub(super) async fn update(&self, record: &Arc<Mutex<OperationRecord>>) -> Result<()> {
        record.lock().await.updated_at = Timestamp::now();
        self.persist().await
    }

    /// Spools one batch of decoded output, keeping each pipe's head and newest tail within
    /// the operation's `limit` and the global quota; bytes beyond them are only counted, so
    /// the caller keeps draining the agent stream after the quota is exhausted.
    ///
    /// The quota is reserved before writing, so an interrupted write can only over-count it
    /// (startup recounts from disk). The write and the publication of the new sizes run in
    /// their own task: a foreground request whose future is dropped cannot stop them halfway
    /// and leave the record describing bytes that never reached disk.
    pub(super) async fn append_output(
        &self,
        record: &Arc<Mutex<OperationRecord>>,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
        limit: usize,
    ) -> Result<()> {
        let budget = PipeBudget::for_limit(limit.min(self.per_job_quota) as u64);
        let mut usage = self.spool_usage.clone().lock_owned().await;
        let (id, previous) = {
            let current = record.lock().await;
            (current.id, [current.stdout.clone(), current.stderr.clone()])
        };
        let available = (self.global_quota as u64).saturating_sub(*usage);
        let mut growth = available;
        let mut states = previous.clone();
        let planned = Pipe::ALL
            .into_iter()
            .zip([stdout, stderr])
            .zip(&mut states)
            .map(|((pipe, data), state)| {
                let writes = if data.is_empty() {
                    Vec::new()
                } else {
                    state.plan(data.len(), budget, &mut growth)
                };
                (pipe, data, writes)
            })
            .collect::<Vec<_>>();
        *usage += available - growth;
        let directory = self.directory.clone();
        let record = record.clone();
        let written = redoor_core::logging::spawn_in_user_scope(async move {
            // Holding the spool lock until the sizes are published keeps readers from seeing a
            // ring mid-update.
            let _usage = usage;
            let mut failure = None;
            for (((pipe, data, writes), state), previous) in
                planned.into_iter().zip(&mut states).zip(previous)
            {
                if failure.is_some() {
                    // Unwritten bytes cannot join the ring without breaking its order.
                    *state = previous.dropping_ring(data.len());
                    continue;
                }
                let path = spool_path(&directory, id, pipe);
                if let Err(error) = write_spool(&path, &data, writes).await {
                    // The ring may be partly overwritten in place, so only the head is
                    // trusted; trimming is best effort, since the state no longer covers
                    // the rest anyway.
                    *state = previous.dropping_ring(data.len());
                    if let Ok(file) = tokio::fs::OpenOptions::new().write(true).open(&path).await {
                        let _ = file.set_len(state.head).await;
                    }
                    failure = Some(error);
                }
            }
            let [stdout, stderr] = states;
            let mut current = record.lock().await;
            current.stdout = stdout;
            current.stderr = stderr;
            current.updated_at = Timestamp::now();
            failure
        })
        .await
        .context("spooling MCP command output")?;
        self.persist().await?;
        match written {
            Some(error) => Err(error).context("writing MCP output spool"),
            None => Ok(()),
        }
    }

    /// Reads up to `limit` retained bytes of one pipe from `start`, in output order, together
    /// with the spool state they were read under, so offsets and the omitted gap match the
    /// bytes even while the command keeps writing.
    pub(super) async fn read_output(
        &self,
        record: &Arc<Mutex<OperationRecord>>,
        pipe: Pipe,
        start: u64,
        limit: u64,
    ) -> Result<(SpoolState, Vec<u8>)> {
        let _usage = self.spool_usage.lock().await;
        let (id, state) = {
            let current = record.lock().await;
            (current.id, current.spool(pipe).clone())
        };
        let start = start.min(state.retained());
        let end = start.saturating_add(limit).min(state.retained());
        let mut bytes = Vec::with_capacity((end - start) as usize);
        if end > start {
            let mut file = tokio::fs::File::open(spool_path(&self.directory, id, pipe)).await?;
            for (offset, length) in state.file_ranges(start, end) {
                file.seek(std::io::SeekFrom::Start(offset)).await?;
                let filled = bytes.len();
                bytes.resize(filled + length as usize, 0);
                file.read_exact(&mut bytes[filled..]).await?;
            }
        }
        Ok((state, bytes))
    }

    /// Reserves one principal's retry key through admission and durable result publication.
    pub(super) async fn lock_admission(
        &self,
        owner: Uuid,
        key: &str,
    ) -> tokio::sync::OwnedMutexGuard<()> {
        let mut locks = self.admission_locks.lock().await;
        locks.retain(|_, lock| lock.strong_count() > 0);
        let lock = locks
            .entry(idempotency_key(owner, key))
            .or_default()
            .upgrade()
            .unwrap_or_else(|| {
                let lock = Arc::new(Mutex::new(()));
                locks.insert(idempotency_key(owner, key), Arc::downgrade(&lock));
                lock
            });
        drop(locks);
        lock.lock_owned().await
    }

    /// Returns a prior idempotent result only for an identical normalized request.
    pub(super) async fn idempotent_result(
        &self,
        owner: Uuid,
        key: &str,
        fingerprint: &str,
    ) -> std::result::Result<Option<Value>, ()> {
        let records = self.idempotency.lock().await;
        match records.get(&idempotency_key(owner, key)) {
            Some(record) if record.fingerprint == fingerprint => Ok(Some(record.result.clone())),
            Some(_) => Err(()),
            None => Ok(None),
        }
    }

    /// Durably publishes a successful admission result for safe retries.
    pub(super) async fn remember(
        &self,
        owner: Uuid,
        key: String,
        fingerprint: String,
        result: Value,
    ) -> Result<()> {
        self.idempotency.lock().await.insert(
            idempotency_key(owner, &key),
            IdempotencyRecord {
                fingerprint,
                result,
            },
        );
        self.persist().await
    }

    /// Removes expired records and their private spools without touching active work.
    async fn expire(&self) -> Result<()> {
        let cutoff = Timestamp::now().checked_sub(self.expiry)?;
        let entries = self
            .records
            .lock()
            .await
            .iter()
            .map(|(id, record)| (*id, record.clone()))
            .collect::<Vec<_>>();
        let mut expired = Vec::new();
        for (id, record) in entries {
            let record = record.lock().await;
            if record.updated_at < cutoff && !record.is_active() {
                expired.push(id);
            }
        }
        if expired.is_empty() {
            return Ok(());
        }
        let mut usage = self.spool_usage.lock().await;
        let mut records = self.records.lock().await;
        for id in expired {
            let Some(record) = records.remove(&id) else {
                continue;
            };
            let record = record.lock().await;
            for pipe in Pipe::ALL {
                *usage = usage.saturating_sub(record.spool(pipe).retained());
                remove_if_present(&spool_path(&self.directory, id, pipe)).await?;
            }
        }
        Ok(())
    }

    /// Replaces the metadata document atomically while output bytes remain separate.
    async fn persist(&self) -> Result<()> {
        let _guard = self.persist_lock.lock().await;
        let entries = self
            .records
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut records = Vec::with_capacity(entries.len());
        for record in entries {
            records.push(record.lock().await.clone());
        }
        let document = PersistedOperations {
            records,
            idempotency: self.idempotency.lock().await.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&document)?;
        let temporary = self
            .directory
            .join(format!("{METADATA_TEMP_PREFIX}{}", Uuid::new_v4()));
        tokio::fs::write(&temporary, bytes).await?;
        if let Err(error) = tokio::fs::rename(&temporary, self.metadata_path.as_ref()).await {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error.into());
        }
        Ok(())
    }
}

/// Applies one pipe's planned writes to its spool file.
async fn write_spool(path: &Path, data: &[u8], writes: Vec<SpoolWrite>) -> std::io::Result<()> {
    if writes.is_empty() {
        return Ok(());
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(path)
        .await?;
    for write in writes {
        file.seek(std::io::SeekFrom::Start(write.file_offset))
            .await?;
        file.write_all(&data[write.data]).await?;
    }
    file.flush().await
}

/// Spool file of one operation pipe; the name is what the startup sweep recognizes.
fn spool_path(directory: &Path, id: Uuid, pipe: Pipe) -> PathBuf {
    directory.join(format!("{id}.{}", pipe.spool_suffix()))
}

/// Reconciles one recovered record's pipe with its spool file and returns the bytes kept.
///
/// The record and the file are written separately, so a crash leaves either more bytes on
/// disk than recorded (written after the last persist; cut off) or fewer (persisted before
/// the write; the state shrinks). Quota accounting then starts from what is really on disk.
async fn adopt_spool(path: &Path, state: &mut SpoolState) -> Result<u64> {
    let on_disk = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.is_file() => metadata.len(),
        Ok(_) => 0,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error).context("inspecting MCP output spool"),
    };
    state.clamp_to(on_disk);
    // A recovered operation never appends again.
    state.head_closed = true;
    let kept = state.retained();
    if kept == 0 {
        remove_if_present(path).await?;
    } else if on_disk > kept {
        tokio::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .await?
            .set_len(kept)
            .await
            .context("trimming MCP output spool")?;
    }
    Ok(kept)
}

/// Deletes spool and metadata leftovers no live record owns: spools of dropped or expired
/// records, spools in an older format, and temporary metadata files of an interrupted
/// write. Only regular files directly in the operation directory with a recognized name
/// are removed, so unrelated files are never touched.
async fn sweep_orphans(directory: &Path, live: &HashSet<Uuid>) -> Result<()> {
    let mut entries = tokio::fs::read_dir(directory)
        .await
        .context("listing MCP operation directory")?;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !is_orphan(name, live) || entry.file_type().await?.is_dir() {
            continue;
        }
        log!(Level::Info, "Removing orphaned MCP operation file {name}");
        remove_if_present(&entry.path()).await?;
    }
    Ok(())
}

/// Recognizes a file the operation store created that no live record owns.
fn is_orphan(name: &str, live: &HashSet<Uuid>) -> bool {
    if let Some(suffix) = name.strip_prefix(METADATA_TEMP_PREFIX) {
        return Uuid::try_parse(suffix).is_ok();
    }
    let Some((id, suffix)) = name.split_once('.') else {
        return false;
    };
    let Ok(id) = Uuid::try_parse(id) else {
        return false;
    };
    // `output` is the single NDJSON spool of the previous format, which nothing reads now.
    suffix == "output"
        || (Pipe::ALL.iter().any(|pipe| pipe.spool_suffix() == suffix) && !live.contains(&id))
}

/// Removes a file that may already be gone, since cleanup runs again after every crash.
async fn remove_if_present(path: &Path) -> Result<()> {
    match tokio::fs::remove_file(path).await {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            Err(error).context("removing MCP operation file")
        }
        _ => Ok(()),
    }
}

/// Parses positive byte/time limits while retaining safe defaults for invalid values.
fn environment_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}
/// Names idempotency entries without exposing bearer credential identifiers.
fn idempotency_key(owner: Uuid, key: &str) -> String {
    format!("{owner}:{key}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Gives each test its own directory so parallel tests never share spools.
    fn test_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("mcp-{name}-{}", Uuid::new_v4()))
    }

    /// Replays a plan against an in-memory file, so retention logic is tested without disk.
    fn apply(file: &mut Vec<u8>, data: &[u8], writes: Vec<SpoolWrite>) {
        for write in writes {
            let offset = write.file_offset as usize;
            let bytes = &data[write.data];
            if file.len() < offset + bytes.len() {
                file.resize(offset + bytes.len(), 0);
            }
            file[offset..offset + bytes.len()].copy_from_slice(bytes);
        }
    }

    /// Reads the retained output of an in-memory file in output order.
    fn retained(file: &[u8], state: &SpoolState) -> Vec<u8> {
        state
            .file_ranges(0, state.retained())
            .into_iter()
            .flat_map(|(offset, length)| file[offset as usize..(offset + length) as usize].to_vec())
            .collect()
    }

    /// Feeding output in many chunk sizes must always keep exactly the head and newest tail.
    #[test]
    fn retention_keeps_head_and_rolling_tail() {
        let output = (0..5000u32)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let budget = PipeBudget::for_limit(400);
        for chunk in [1, 3, 7, 64, 99, 100, 101, 250, 5000] {
            let mut state = SpoolState::default();
            let mut file = Vec::new();
            let mut growth = u64::MAX;
            for piece in output.chunks(chunk) {
                let writes = state.plan(piece.len(), budget, &mut growth);
                apply(&mut file, piece, writes);
            }
            let mut expected = output[..100].to_vec();
            expected.extend_from_slice(&output[output.len() - 100..]);
            // Head and tail are both half of the pipe's 200-byte share, in output order.
            assert_eq!(retained(&file, &state), expected, "chunk size {chunk}");
            // The file never grows past the budget, which is what bounds disk use.
            assert_eq!(file.len(), 200, "chunk size {chunk}");
            // Everything between head and tail is reported, so callers can show the gap.
            assert_eq!(state.omitted(), 4800, "chunk size {chunk}");
        }
    }

    /// Output that fits the budget is kept whole without an omitted gap.
    #[test]
    fn retention_keeps_short_output_whole() {
        let mut state = SpoolState::default();
        let mut file = Vec::new();
        let mut growth = u64::MAX;
        for piece in [&b"hello "[..], b"world"] {
            let writes = state.plan(piece.len(), PipeBudget::for_limit(16), &mut growth);
            apply(&mut file, piece, writes);
        }
        // A 16-byte limit keeps four head and four tail bytes per pipe; the dropped middle
        // proves the gap sits exactly between head and tail even when the ring wrapped.
        assert_eq!(retained(&file, &state), b"hellorld");
        // The omitted count is exactly the middle the budget could not keep.
        assert_eq!(state.omitted(), 3);
        let mut whole = SpoolState::default();
        let mut file = Vec::new();
        let writes = whole.plan(5, PipeBudget::for_limit(64), &mut growth);
        apply(&mut file, b"short", writes);
        // Short output is retained unchanged.
        assert_eq!(retained(&file, &whole), b"short");
        // Nothing was dropped, so no gap is reported.
        assert_eq!(whole.omitted(), 0);
    }

    /// An exhausted global quota stops growth but keeps rolling the newest bytes through the
    /// ring already granted.
    #[test]
    fn retention_rolls_tail_within_granted_space_when_quota_is_exhausted() {
        let mut state = SpoolState::default();
        let mut file = Vec::new();
        let budget = PipeBudget::for_limit(400);
        // Enough growth for the 100-byte head and 10 tail bytes.
        let mut growth = 110;
        let output = (0..1000u32).map(|index| index as u8).collect::<Vec<_>>();
        for piece in output.chunks(37) {
            let writes = state.plan(piece.len(), budget, &mut growth);
            apply(&mut file, piece, writes);
        }
        // Retention never exceeds what the global quota granted.
        assert_eq!(file.len(), 110);
        // The tail still holds the newest bytes rather than the first ones after the head.
        assert_eq!(&retained(&file, &state)[100..], &output[990..]);
        // The gap covers everything between head and the shrunken tail.
        assert_eq!(state.omitted(), 890);
    }

    /// Aging records directly exercises retention without racing a short wall-clock deadline.
    #[tokio::test]
    async fn expiry_removes_only_old_terminal_records_and_their_spools() {
        let directory = test_directory("expiry");
        let mut registry = OperationRegistry::in_directory(directory.clone())
            .await
            .unwrap();
        registry.expiry = Duration::from_secs(60);
        let owner = Uuid::new_v4();
        let mut retained = Vec::new();
        let mut expired = Vec::new();
        for state in [
            "admitted",
            "running",
            "canceling",
            "completed",
            "failed",
            "canceled",
            "timed_out",
            "interrupted",
            "unknown",
        ] {
            let record = registry.create(owner, vec![], "command").await.unwrap();
            registry
                .append_output(&record, b"output".to_vec(), b"error".to_vec(), 512)
                .await
                .unwrap();
            let id = record.lock().await.id;
            let entry = (id, spool_path(&directory, id, Pipe::Stdout), record, state);
            if matches!(state, "admitted" | "running" | "canceling") {
                retained.push(entry);
            } else {
                expired.push(entry);
            }
        }
        let fresh = registry.create(owner, vec![], "command").await.unwrap();
        fresh.lock().await.state = "completed".to_string();
        // Age only after all admissions, since create itself runs expiry.
        for (_, _, record, state) in retained.iter().chain(&expired) {
            let mut current = record.lock().await;
            current.state = state.to_string();
            current.updated_at = Timestamp::now()
                .checked_sub(Duration::from_secs(120))
                .unwrap();
        }
        for (id, path, _, _) in expired {
            assert!(
                registry.get(id).await.unwrap().is_none(),
                "old terminal operations must no longer be addressable"
            );
            assert!(
                !tokio::fs::try_exists(path).await.unwrap(),
                "expiry must reclaim the terminal operation's retained output"
            );
        }
        for (id, path, _, _) in &retained {
            assert!(
                registry.get(*id).await.unwrap().is_some(),
                "retention must not remove active work even when it has been idle"
            );
            assert!(
                tokio::fs::try_exists(path).await.unwrap(),
                "active work must keep its retained output"
            );
        }
        assert_eq!(
            *registry.spool_usage.lock().await,
            retained.len() as u64 * 11,
            "expiry must return the reclaimed bytes to the global quota"
        );
        let fresh_id = fresh.lock().await.id;
        assert!(
            registry.get(fresh_id).await.unwrap().is_some(),
            "recent terminal operations must remain available to callers"
        );
        redoor_core::safe_fs::safe_rm_all(&directory).await.unwrap();
    }

    /// Recovery must detach all persisted states from counters reused by the next router.
    #[tokio::test]
    async fn restart_invalidates_remote_ids_for_active_and_terminal_operations() {
        let directory = test_directory("recovery");
        let registry = OperationRegistry::in_directory(directory.clone())
            .await
            .unwrap();
        let owner = Uuid::new_v4();
        let mut ids = Vec::new();
        for state in [
            "running",
            "completed",
            "failed",
            "canceled",
            "interrupted",
            "unknown",
        ] {
            let record = registry.create(owner, vec![], "copy").await.unwrap();
            let mut current = record.lock().await;
            current.remote_id = Some(1);
            current.state = state.to_string();
            ids.push((current.id, state));
            drop(current);
            registry.update(&record).await.unwrap();
        }
        let recovered = OperationRegistry::in_directory(directory.clone())
            .await
            .unwrap();
        for (id, state) in ids {
            let record = recovered.get(id).await.unwrap().unwrap();
            let current = record.lock().await;
            assert_eq!(
                current.remote_id, None,
                "no recovered record may target a new router counter"
            );
            assert_eq!(
                current.state,
                if state == "running" {
                    "interrupted"
                } else {
                    state
                },
                "recovery preserves terminal outcomes and marks only unacknowledged active work interrupted"
            );
        }
        redoor_core::safe_fs::safe_rm_all(&directory).await.unwrap();
    }

    /// Startup removes files no record owns but leaves unrelated files alone.
    #[tokio::test]
    async fn startup_sweep_removes_orphans_and_keeps_unrelated_files() {
        let directory = test_directory("sweep");
        let registry = OperationRegistry::in_directory(directory.clone())
            .await
            .unwrap();
        let record = registry
            .create(Uuid::new_v4(), vec![], "command")
            .await
            .unwrap();
        registry
            .append_output(&record, b"kept".to_vec(), Vec::new(), 512)
            .await
            .unwrap();
        let live = record.lock().await.id;
        let orphan = Uuid::new_v4();
        let orphans = [
            spool_path(&directory, orphan, Pipe::Stdout),
            directory.join(format!("{orphan}.output")),
            directory.join(format!("{METADATA_TEMP_PREFIX}{}", Uuid::new_v4())),
            directory.join(format!("{live}.output")),
        ];
        for path in &orphans {
            tokio::fs::write(path, b"stale").await.unwrap();
        }
        let unrelated = [
            directory.join("notes.txt"),
            directory.join(format!("{live}.txt")),
            directory.join(format!("{orphan}.txt")),
            directory.join(format!("{METADATA_TEMP_PREFIX}not-a-uuid")),
        ];
        for path in &unrelated {
            tokio::fs::write(path, b"keep").await.unwrap();
        }
        drop(registry);
        let recovered = OperationRegistry::in_directory(directory.clone())
            .await
            .unwrap();
        for path in &orphans {
            assert!(
                !tokio::fs::try_exists(path).await.unwrap(),
                "spools without a record, old-format spools and crashed metadata writes are removed: {path:?}"
            );
        }
        for path in &unrelated {
            assert!(
                tokio::fs::try_exists(path).await.unwrap(),
                "files the store did not create must never be swept: {path:?}"
            );
        }
        let record = recovered.get(live).await.unwrap().unwrap();
        let (_, bytes) = recovered
            .read_output(&record, Pipe::Stdout, 0, 64)
            .await
            .unwrap();
        // The live record's spool survives the sweep with its content.
        assert_eq!(bytes, b"kept");
        // Accounting is rebuilt from the surviving spool alone.
        assert_eq!(*recovered.spool_usage.lock().await, 4);
        redoor_core::safe_fs::safe_rm_all(&directory).await.unwrap();
    }

    /// A running record from a crashed process becomes interrupted, and its spool is
    /// reconciled with what reached disk in both directions.
    #[tokio::test]
    async fn startup_reconciles_stale_running_records_with_their_spools() {
        let directory = test_directory("reconcile");
        let registry = OperationRegistry::in_directory(directory.clone())
            .await
            .unwrap();
        let owner = Uuid::new_v4();
        let longer = registry.create(owner, vec![], "command").await.unwrap();
        let missing = registry.create(owner, vec![], "command").await.unwrap();
        for record in [&longer, &missing] {
            record.lock().await.state = "running".to_string();
            registry
                .append_output(record, b"0123456789".to_vec(), Vec::new(), 512)
                .await
                .unwrap();
        }
        let longer_id = longer.lock().await.id;
        let missing_id = missing.lock().await.id;
        // A write that landed after the last persist leaves extra bytes on disk.
        let mut file = tokio::fs::OpenOptions::new()
            .append(true)
            .open(spool_path(&directory, longer_id, Pipe::Stdout))
            .await
            .unwrap();
        file.write_all(b"unrecorded").await.unwrap();
        drop(file);
        // A persist that ran before its write leaves a record whose spool never appeared.
        tokio::fs::remove_file(spool_path(&directory, missing_id, Pipe::Stdout))
            .await
            .unwrap();
        drop(registry);
        let recovered = OperationRegistry::in_directory(directory.clone())
            .await
            .unwrap();
        let longer = recovered.get(longer_id).await.unwrap().unwrap();
        let (state, bytes) = recovered
            .read_output(&longer, Pipe::Stdout, 0, 64)
            .await
            .unwrap();
        // The work never got a terminal acknowledgement, so it is reported interrupted.
        assert_eq!(longer.lock().await.state, "interrupted");
        // Bytes the record never acknowledged are cut off instead of being served.
        assert_eq!(bytes, b"0123456789");
        assert_eq!(
            tokio::fs::metadata(spool_path(&directory, longer_id, Pipe::Stdout))
                .await
                .unwrap()
                .len(),
            10,
            "the trimmed spool must not keep using disk"
        );
        // Nothing was lost from this record.
        assert_eq!(state.omitted(), 0);
        let missing = recovered.get(missing_id).await.unwrap().unwrap();
        let (state, bytes) = recovered
            .read_output(&missing, Pipe::Stdout, 0, 64)
            .await
            .unwrap();
        // Reading a record whose spool vanished must not fail; it simply has no output.
        assert!(bytes.is_empty());
        // The lost bytes are reported as omitted rather than silently forgotten.
        assert_eq!(state.omitted(), 10);
        // Interrupted records follow normal expiry instead of staying active forever.
        assert!(!missing.lock().await.is_active());
        // Only the bytes actually on disk count against the global quota.
        assert_eq!(*recovered.spool_usage.lock().await, 10);
        redoor_core::safe_fs::safe_rm_all(&directory).await.unwrap();
    }

    /// A full ring of interrupted work may hold an in-place write the record never saw, even
    /// before it first wrapped, so recovery drops it; a finished operation's ring was
    /// persisted after its last write and stays.
    #[tokio::test]
    async fn startup_discards_rings_of_interrupted_work() {
        let directory = test_directory("rings");
        let registry = OperationRegistry::in_directory(directory.clone())
            .await
            .unwrap();
        let owner = Uuid::new_v4();
        let interrupted = registry.create(owner, vec![], "command").await.unwrap();
        let finished = registry.create(owner, vec![], "command").await.unwrap();
        // A 16-byte limit keeps a four-byte head and a four-byte ring per pipe. Eight bytes
        // fill the ring without wrapping it; twelve wrap it.
        for (record, state, output) in [
            (&interrupted, "running", &b"abcdefgh"[..]),
            (&finished, "completed", b"abcdefghijkl"),
        ] {
            record.lock().await.state = state.to_string();
            registry
                .append_output(record, output.to_vec(), Vec::new(), 16)
                .await
                .unwrap();
        }
        let interrupted_id = interrupted.lock().await.id;
        let finished_id = finished.lock().await.id;
        // Simulate the first in-place overwrite of the full ring reaching disk, followed by a
        // crash before the record was persisted.
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .open(spool_path(&directory, interrupted_id, Pipe::Stdout))
            .await
            .unwrap();
        file.seek(std::io::SeekFrom::Start(4)).await.unwrap();
        file.write_all(b"i").await.unwrap();
        drop(file);
        drop(registry);
        let recovered = OperationRegistry::in_directory(directory.clone())
            .await
            .unwrap();
        let record = recovered.get(interrupted_id).await.unwrap().unwrap();
        let (state, bytes) = recovered
            .read_output(&record, Pipe::Stdout, 0, 64)
            .await
            .unwrap();
        // Only the head survives, so no out-of-order tail is ever served.
        assert_eq!(bytes, b"abcd");
        // The dropped ring bytes are reported as omitted.
        assert_eq!(state.omitted(), 4);
        assert_eq!(
            tokio::fs::metadata(spool_path(&directory, interrupted_id, Pipe::Stdout))
                .await
                .unwrap()
                .len(),
            4,
            "the discarded ring must not keep using disk"
        );
        let record = recovered.get(finished_id).await.unwrap().unwrap();
        let (_, bytes) = recovered
            .read_output(&record, Pipe::Stdout, 0, 64)
            .await
            .unwrap();
        // A terminal record's ring matches its persisted state, so its tail is kept.
        assert_eq!(bytes, b"abcdijkl");
        // Usage counts the trimmed interrupted spool and the intact finished one.
        assert_eq!(*recovered.spool_usage.lock().await, 12);
        redoor_core::safe_fs::safe_rm_all(&directory).await.unwrap();
    }

    /// A failed spool write keeps the output retained before it readable.
    #[tokio::test]
    async fn failed_write_keeps_earlier_output_readable() {
        let directory = test_directory("write-failure");
        let registry = OperationRegistry::in_directory(directory.clone())
            .await
            .unwrap();
        let record = registry
            .create(Uuid::new_v4(), vec![], "command")
            .await
            .unwrap();
        // Fill the four-byte head and the four-byte ring of a 16-byte limit.
        registry
            .append_output(&record, b"abcdefgh".to_vec(), Vec::new(), 16)
            .await
            .unwrap();
        let path = spool_path(&directory, record.lock().await.id, Pipe::Stdout);
        // A read-only spool makes the next write fail like a full or broken disk would.
        tokio::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o400))
            .await
            .unwrap();
        if tokio::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .await
            .is_ok()
        {
            // Root ignores file permissions, so the failure cannot be simulated this way.
            redoor_core::safe_fs::safe_rm_all(&directory).await.unwrap();
            return;
        }
        let failed = registry
            .append_output(&record, b"ij".to_vec(), Vec::new(), 16)
            .await;
        // The caller learns about the failure so it can fail the operation.
        assert!(failed.is_err());
        let (state, bytes) = registry
            .read_output(&record, Pipe::Stdout, 0, 64)
            .await
            .unwrap();
        // The head written earlier is still served; the possibly damaged ring is not.
        assert_eq!(bytes, b"abcd");
        // The ring and the unwritten bytes are reported as omitted.
        assert_eq!(state.omitted(), 6);
        redoor_core::safe_fs::safe_rm_all(&directory).await.unwrap();
    }

    /// Metadata written by an older format is discarded instead of failing startup.
    #[tokio::test]
    async fn startup_discards_unreadable_metadata() {
        let directory = test_directory("old-metadata");
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let old = Uuid::new_v4();
        tokio::fs::write(
            directory.join(METADATA_FILE),
            serde_json::to_vec(&serde_json::json!({
                "records": [{"id": old, "output_size": 3, "output_truncated": false}],
                "idempotency": {}
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        tokio::fs::write(directory.join(format!("{old}.output")), b"old")
            .await
            .unwrap();
        let registry = OperationRegistry::in_directory(directory.clone())
            .await
            .unwrap();
        // The old record cannot be read, so it is no longer addressable.
        assert!(registry.get(old).await.unwrap().is_none());
        // Its old-format spool is swept with it.
        assert!(
            !tokio::fs::try_exists(directory.join(format!("{old}.output")))
                .await
                .unwrap()
        );
        tokio::fs::write(directory.join(METADATA_FILE), b"{not json")
            .await
            .unwrap();
        // A corrupt document starts an empty store instead of preventing startup.
        assert!(
            OperationRegistry::in_directory(directory.clone())
                .await
                .is_ok()
        );
        redoor_core::safe_fs::safe_rm_all(&directory).await.unwrap();
    }
}
