//! Counts the uncommitted changes of the checkouts in the worktree list.
//!
//! Kept out of the list itself because a status walk visits every file of a checkout, so the
//! browser shows the list at once and asks for the counts of the rows it shows in one request.

use std::{future::Future, time::Duration};

use futures_util::{StreamExt, stream::FuturesUnordered};
use tokio::{sync::Semaphore, time::Instant};
use tokio_util::sync::CancellationToken;

use redoor_core::log;
use redoor_protocol::{
    api::git::{
        GitChangeState,
        worktree_status::{
            GitWorktreeChanges, GitWorktreeStatusEntry, GitWorktreeStatusResponse,
            GitWorktreeStatusResult, MAX_GIT_WORKTREE_CHANGES,
        },
    },
    wire::{command::CommandErrorKind, log::Level, request::CommandError},
};

use super::{
    discover_required_repository, run_blocking,
    status::{StatusCollection, collect_status},
};

/// Status walks allowed to run at once. A request names every visible row of the list, and
/// each gix walk already spreads over all cores, so running more of them at once only makes
/// the disk seek between checkouts; the rest wait their turn here.
const WORKTREE_STATUS_SLOTS: usize = 2;

/// Queue shared by every connection, because the disk being walked is shared too.
static WORKTREE_STATUS_PERMITS: Semaphore = Semaphore::const_new(WORKTREE_STATUS_SLOTS);

/// How long one request walks checkouts before answering with the counts it has. Without it
/// a long list of large checkouts would hold the browser's request for minutes before any
/// row showed its counts; with it the rows fill in every few seconds as the browser asks
/// again for the rest.
const WORKTREE_STATUS_BUDGET: Duration = Duration::from_secs(5);

/// Counts the checkouts containing `paths` until the time budget runs out.
///
/// A checkout that cannot be counted is reported as failed instead of failing the request,
/// so it does not hide the counts of the others. When `cancel` fires (the browser left the
/// list or the connection ended) the walks are dropped at once, which interrupts gix and
/// frees their queue slots for requests someone still waits for; the empty answer goes to
/// nobody.
pub(crate) async fn statuses(
    paths: Vec<String>,
    cancel: &CancellationToken,
) -> Result<GitWorktreeStatusResponse, CommandError> {
    let requested = paths.len();
    let started_at = Instant::now();
    let walks: FuturesUnordered<_> = paths
        .into_iter()
        .map(|path| async move {
            let result = match count(path.clone()).await {
                Ok(changes) => GitWorktreeStatusResult::Counted(changes),
                Err(error) => GitWorktreeStatusResult::Failed {
                    message: error.message,
                },
            };
            GitWorktreeStatusEntry { path, result }
        })
        .collect();
    let Some(statuses) = cancel
        .run_until_cancelled(collect_within_budget(
            walks,
            started_at + WORKTREE_STATUS_BUDGET,
        ))
        .await
    else {
        // Lets an operator confirm that leaving the worktree list stops the walks on the agent.
        log!(
            Level::Debug,
            "Git worktree status canceled: paths={requested} elapsed_ms={}",
            started_at.elapsed().as_millis()
        );
        return Ok(GitWorktreeStatusResponse {
            statuses: Vec::new(),
        });
    };
    Ok(GitWorktreeStatusResponse { statuses })
}

/// Gathers walks as they finish until `deadline`, then drops the unfinished ones, which
/// interrupts their gix walks and frees their queue slots for the next request.
///
/// When nothing has finished by the deadline it waits for the first walk anyway, so a
/// checkout slower than the budget is still counted and asking again for the rest always
/// makes progress instead of restarting the same walk forever.
async fn collect_within_budget<T>(
    mut walks: FuturesUnordered<impl Future<Output = T>>,
    deadline: Instant,
) -> Vec<T> {
    let mut finished = Vec::new();
    loop {
        let next = if finished.is_empty() {
            walks.next().await
        } else {
            match tokio::time::timeout_at(deadline, walks.next()).await {
                Ok(next) => next,
                Err(_) => break,
            }
        };
        match next {
            Some(walk) => finished.push(walk),
            None => break,
        }
    }
    finished
}

/// Counts the uncommitted paths of the checkout containing `path`, once a slot is free.
///
/// Waiting for the slot happens before the blocking walk starts, so a walk dropped at the
/// deadline leaves the queue without ever touching the disk.
async fn count(path: String) -> Result<GitWorktreeChanges, CommandError> {
    let _permit = WORKTREE_STATUS_PERMITS.acquire().await.map_err(|_| {
        CommandError::new(
            CommandErrorKind::Internal,
            "Git worktree status queue is unavailable",
        )
    })?;
    run_blocking(move |interrupt| {
        let repository = discover_required_repository(&path)?;
        let StatusCollection {
            changes,
            omitted_non_utf8_entries,
            overflowed,
        } = collect_status(
            &repository.repo,
            |_| true,
            false,
            MAX_GIT_WORKTREE_CHANGES,
            Vec::new(),
            interrupt,
        )?;

        let mut counts = GitWorktreeChanges {
            // Paths that are not UTF-8 are still uncommitted work, so they keep a checkout
            // from looking clean even though they cannot be classified.
            changed: u32::try_from(omitted_non_utf8_entries).unwrap_or(u32::MAX),
            untracked: 0,
            truncated: overflowed,
        };
        for status in changes.values() {
            let untracked = status.index_state == GitChangeState::Unmodified
                && status.worktree_state == GitChangeState::Added
                && status.conflict_state.is_none();
            if untracked {
                counts.untracked += 1;
            } else {
                counts.changed += 1;
            }
        }
        Ok(counts)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in walk that finishes with `id` after `seconds` of paused tokio time.
    async fn walk(id: u32, seconds: u64) -> u32 {
        tokio::time::sleep(Duration::from_secs(seconds)).await;
        id
    }

    /// Walks that finish within the budget are returned and slower ones are left out.
    #[tokio::test(start_paused = true)]
    async fn returns_the_walks_finished_by_the_deadline() {
        let walks: FuturesUnordered<_> =
            [walk(1, 1), walk(2, 3), walk(3, 60)].into_iter().collect();
        let started = Instant::now();

        let finished = collect_within_budget(walks, started + Duration::from_secs(5)).await;

        // The walk still running at the deadline is dropped instead of awaited.
        assert_eq!(finished, [1, 2]);
        // The answer comes at the deadline, not when the slow walk would finish.
        assert_eq!(started.elapsed(), Duration::from_secs(5));
    }

    /// Without any finished walk the budget is extended until the first one finishes.
    #[tokio::test(start_paused = true)]
    async fn waits_past_the_deadline_for_the_first_walk() {
        let walks: FuturesUnordered<_> = [walk(1, 30), walk(2, 8)].into_iter().collect();
        let started = Instant::now();

        let finished = collect_within_budget(walks, started + Duration::from_secs(5)).await;

        // Asking again for the rest makes progress because one checkout is always counted.
        assert_eq!(finished, [2]);
        // Only the first walk past the deadline is awaited, not the slower one after it.
        assert_eq!(started.elapsed(), Duration::from_secs(8));
    }

    /// A canceled request answers at once without starting any walk.
    #[tokio::test]
    async fn canceled_request_answers_without_walking() {
        let cancel = CancellationToken::new();
        cancel.cancel();

        let response = statuses(vec!["/".to_string()], &cancel).await.unwrap();

        // Nobody waits for the answer, so no checkout is counted or reported.
        assert!(response.statuses.is_empty());
        // The queue is untouched, so requests someone still waits for get every slot.
        assert_eq!(
            WORKTREE_STATUS_PERMITS.available_permits(),
            WORKTREE_STATUS_SLOTS
        );
    }

    /// A request whose walks all finish early answers without waiting for the deadline.
    #[tokio::test(start_paused = true)]
    async fn answers_as_soon_as_every_walk_finishes() {
        let walks: FuturesUnordered<_> = [walk(1, 1), walk(2, 2)].into_iter().collect();
        let started = Instant::now();

        let finished = collect_within_budget(walks, started + Duration::from_secs(5)).await;

        // Every walk is reported and the budget is not spent idling.
        assert_eq!(finished, [1, 2]);
        assert_eq!(started.elapsed(), Duration::from_secs(2));
    }
}
