//! A repository's branches or tags, most recently committed first or by name, one page at a
//! time. The default branch always leads the branches.

use std::{cmp::Ordering, collections::BinaryHeap, sync::atomic::AtomicBool};

use gix::bstr::ByteSlice;

use redoor_protocol::{
    api::git::{
        GitPage,
        refs::{
            GitBranchScope, GitRef, GitRefKind, GitRefListKind, GitRefListResponse, GitRefSort,
        },
    },
    wire::{command::CommandErrorKind, request::CommandError},
};

use super::{
    GitFailure, check_interrupt, discover_required_repository, internal_failure,
    revision::{commit_summary, peel_to_commit},
    run_blocking,
};

/// A ref that may belong on the page, ordered by the listing's sort.
#[derive(PartialEq, Eq)]
struct Candidate {
    /// Carried by every candidate because the heap orders them through [`Ord`], which has no
    /// other way to learn the listing's sort.
    sort: GitRefSort,
    /// Committer time, so a rebased or freshly merged branch counts as recent. Left at zero
    /// when sorting by name, which does not need the commit read.
    time: i64,
    /// The repository's default branch, which leads the list in either order because it is
    /// the branch people compare everything else against.
    is_default: bool,
    full_name: String,
    kind: GitRefKind,
    commit_id: gix::ObjectId,
}

impl Ord for Candidate {
    /// The default branch sorts first, then newer commits or lower names. Ties fall back to the exact full name, which
    /// is unique, so pages are stable. Names compare in full, so local branches under
    /// `refs/heads/` lead remote-tracking ones like in `git branch -a`.
    fn cmp(&self, other: &Self) -> Ordering {
        let primary = match self.sort {
            GitRefSort::Recent => other.time.cmp(&self.time),
            GitRefSort::Name => compare_natural(&self.full_name, &other.full_name),
        };
        other
            .is_default
            .cmp(&self.is_default)
            .then(primary)
            .then_with(|| self.full_name.cmp(&other.full_name))
    }
}

impl PartialOrd for Candidate {
    /// Delegates to the total order above.
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Lists one page of the branches or tags of the repository containing `path`. `scope`
/// narrows a branch listing to local or remote-tracking branches and is ignored for tags.
pub(crate) async fn list(
    path: String,
    kind: GitRefListKind,
    scope: GitBranchScope,
    sort: GitRefSort,
    page: GitPage,
) -> Result<GitRefListResponse, CommandError> {
    run_blocking(move |interrupt| list_blocking(&path, kind, scope, sort, page, &interrupt)).await
}

/// Reads every ref of the kind, keeps only the rows up to the end of the page, then
/// summarizes the page.
///
/// Any order needs every ref, so all refs are visited, but at most `skip + limit`
/// candidates are held at once. A repository with a hundred thousand tags costs reading
/// them, not keeping them. Every ref is still peeled when sorting by name, so both orders
/// count the same refs.
fn list_blocking(
    path: &str,
    kind: GitRefListKind,
    scope: GitBranchScope,
    sort: GitRefSort,
    page: GitPage,
    interrupt: &AtomicBool,
) -> Result<GitRefListResponse, GitFailure> {
    page.validate()
        .map_err(|message| GitFailure::new(CommandErrorKind::InvalidInput, message))?;
    let repository = discover_required_repository(path)?;
    let repo = &repository.repo;
    let head_name = repo
        .head_name()
        .map_err(|error| internal_failure("read repository HEAD", error))?;
    let default_branch = match kind {
        GitRefListKind::Branches => default_branch(repo)?,
        GitRefListKind::Tags => None,
    };
    let references = repo
        .references()
        .map_err(|error| internal_failure("open Git references", error))?;
    let sources = match kind {
        GitRefListKind::Branches => {
            let mut sources = Vec::with_capacity(2);
            if scope != GitBranchScope::Remote {
                sources.push((
                    references
                        .local_branches()
                        .map_err(|error| internal_failure("list Git branches", error))?,
                    GitRefKind::Branch,
                ));
            }
            if scope != GitBranchScope::Local {
                sources.push((
                    references
                        .remote_branches()
                        .map_err(|error| internal_failure("list Git remote branches", error))?,
                    GitRefKind::RemoteBranch,
                ));
            }
            sources
        }
        GitRefListKind::Tags => vec![(
            references
                .tags()
                .map_err(|error| internal_failure("list Git tags", error))?,
            GitRefKind::Tag,
        )],
    };

    let keep = (page.skip + page.limit) as usize;
    // A max-heap under the listing's order holds the last kept candidate on top, so it is
    // the one dropped when a ref that sorts earlier arrives.
    let mut kept = BinaryHeap::with_capacity(keep + 1);
    let mut total = 0;
    for (iter, kind) in sources {
        for reference in iter {
            check_interrupt(interrupt, "Git ref listing")?;
            let reference =
                reference.map_err(|error| internal_failure("read Git reference", error))?;
            // Symbolic refs such as `origin/HEAD` only repeat a branch already listed.
            let Some(target) = reference.try_id() else {
                continue;
            };
            // A name that is not UTF-8 cannot be linked to as a revision.
            let Ok(full_name) = reference.name().as_bstr().to_str() else {
                continue;
            };
            // Tags may name trees or blobs, which have no history to browse.
            let Some(commit_id) = peel_to_commit(repo, target.detach())? else {
                continue;
            };
            let time = match sort {
                GitRefSort::Recent => {
                    repo.find_commit(commit_id)
                        .and_then(|commit| commit.time())
                        .map_err(|error| internal_failure("read Git commit time", error))?
                        .seconds
                }
                GitRefSort::Name => 0,
            };
            total += 1;
            kept.push(Candidate {
                sort,
                time,
                is_default: default_branch.as_deref() == Some(full_name),
                full_name: full_name.to_string(),
                kind,
                commit_id,
            });
            if kept.len() > keep {
                kept.pop();
            }
        }
    }

    let refs = kept
        .into_sorted_vec()
        .into_iter()
        .skip(page.skip as usize)
        .map(|candidate| {
            let commit = repo
                .find_commit(candidate.commit_id)
                .map_err(|error| internal_failure("read Git commit", error))?;
            let is_head = head_name
                .as_ref()
                .is_some_and(|head| head.as_bstr() == candidate.full_name.as_bytes());
            Ok(GitRef {
                name: short_name(&candidate.full_name).to_string(),
                full_name: candidate.full_name,
                kind: candidate.kind,
                is_head,
                is_default: candidate.is_default,
                commit: commit_summary(&commit)?,
            })
        })
        .collect::<Result<Vec<_>, GitFailure>>()?;
    let has_more = (page.skip as usize).saturating_add(refs.len()) < total;
    Ok(GitRefListResponse {
        repository_root: repository.root.display().to_string(),
        refs,
        total,
        has_more,
    })
}

/// Finds the full name of the repository's default branch, or `None` when it cannot be told.
///
/// The default remote's `HEAD` says which branch the project treats as its main line, so it
/// wins, preferring the local branch of the same name, which is the one people check out.
/// Without a remote `HEAD`, such as in a repository that was never cloned, the
/// `init.defaultBranch` setting and the common `main` and `master` names are tried as local
/// branches.
fn default_branch(repo: &gix::Repository) -> Result<Option<String>, GitFailure> {
    let remote = repo
        .remote_default_name(gix::remote::Direction::Fetch)
        .and_then(|name| name.to_str().ok().map(str::to_string))
        .unwrap_or_else(|| "origin".to_string());
    let remote_head = find_reference(repo, &format!("refs/remotes/{remote}/HEAD"))?;
    let remote_target = remote_head.as_ref().and_then(|head| {
        head.target()
            .try_name()
            .and_then(|name| name.as_bstr().to_str().ok())
            .map(str::to_string)
    });
    if let Some(remote_target) = remote_target {
        let prefix = format!("refs/remotes/{remote}/");
        if let Some(branch) = remote_target.strip_prefix(&prefix) {
            let local = format!("refs/heads/{branch}");
            if find_reference(repo, &local)?.is_some() {
                return Ok(Some(local));
            }
        }
        if find_reference(repo, &remote_target)?.is_some() {
            return Ok(Some(remote_target));
        }
    }

    let configured = repo
        .config_snapshot()
        .string("init.defaultBranch")
        .and_then(|name| name.to_str().ok().map(str::to_string));
    for branch in configured
        .into_iter()
        .chain(["main".to_string(), "master".to_string()])
    {
        let local = format!("refs/heads/{branch}");
        if find_reference(repo, &local)?.is_some() {
            return Ok(Some(local));
        }
    }
    Ok(None)
}

/// Looks up a reference without following it. A name that is not a valid ref name, which
/// only hand-edited config can produce, counts as missing rather than failing the listing.
fn find_reference<'repo>(
    repo: &'repo gix::Repository,
    name: &str,
) -> Result<Option<gix::Reference<'repo>>, GitFailure> {
    let Ok(name) = gix::refs::FullName::try_from(name) else {
        return Ok(None);
    };
    repo.try_find_reference(name.as_ref())
        .map_err(|error| internal_failure("read Git reference", error))
}

/// Strips the namespace prefix so rows show names the way `git branch -a` and `git tag` do.
fn short_name(full_name: &str) -> &str {
    ["refs/heads/", "refs/remotes/", "refs/tags/"]
        .iter()
        .find_map(|prefix| full_name.strip_prefix(prefix))
        .unwrap_or(full_name)
}

/// Compares names the way people read them: digit runs by value and letters regardless of
/// case, so `v1.10` follows `v1.9` and `Feature` sits beside `feature`. Plain byte order
/// would scatter version tags, the list people most often look through by name.
fn compare_natural(left: &str, right: &str) -> Ordering {
    let (mut left, mut right) = (left.as_bytes(), right.as_bytes());
    loop {
        match (left.first(), right.first()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(l), Some(r)) if l.is_ascii_digit() && r.is_ascii_digit() => {
                let (left_digits, left_rest) = split_digits(left);
                let (right_digits, right_rest) = split_digits(right);
                let order = compare_number(left_digits, right_digits);
                if order != Ordering::Equal {
                    return order;
                }
                (left, right) = (left_rest, right_rest);
            }
            (Some(l), Some(r)) => {
                let order = l.to_ascii_lowercase().cmp(&r.to_ascii_lowercase());
                if order != Ordering::Equal {
                    return order;
                }
                (left, right) = (&left[1..], &right[1..]);
            }
        }
    }
}

/// Splits the leading run of ASCII digits from the rest of a name.
fn split_digits(bytes: &[u8]) -> (&[u8], &[u8]) {
    let end = bytes
        .iter()
        .position(|byte| !byte.is_ascii_digit())
        .unwrap_or(bytes.len());
    bytes.split_at(end)
}

/// Compares two digit runs by value without parsing them, so a run longer than any integer
/// type, such as a date stamp in a tag, still orders correctly.
fn compare_number(left: &[u8], right: &[u8]) -> Ordering {
    let trim = |digits: &[u8]| -> usize {
        digits
            .iter()
            .position(|&digit| digit != b'0')
            .unwrap_or(digits.len())
    };
    let (left, right) = (&left[trim(left)..], &right[trim(right)..]);
    left.len().cmp(&right.len()).then_with(|| left.cmp(right))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a candidate whose identity is irrelevant to ordering.
    fn candidate(sort: GitRefSort, time: i64, name: &str) -> Candidate {
        Candidate {
            sort,
            time,
            is_default: false,
            full_name: name.to_string(),
            kind: GitRefKind::Branch,
            commit_id: gix::ObjectId::null(gix::hash::Kind::Sha1),
        }
    }

    /// Confirms the newest commits lead and equal times are ordered by name.
    #[test]
    fn candidates_sort_newest_first_then_by_name() {
        let mut sorted = [
            candidate(GitRefSort::Recent, 1, "a"),
            candidate(GitRefSort::Recent, 3, "c"),
            candidate(GitRefSort::Recent, 3, "b"),
        ];
        sorted.sort();
        let names: Vec<_> = sorted.iter().map(|c| c.full_name.as_str()).collect();
        // The newer pair comes first, broken by name, then the older ref.
        assert_eq!(names, ["b", "c", "a"]);
    }

    /// Confirms the name order ignores commit times and compares version numbers by value.
    #[test]
    fn candidates_sort_by_natural_name() {
        let mut sorted = [
            candidate(GitRefSort::Name, 9, "refs/tags/v1.10"),
            candidate(GitRefSort::Name, 1, "refs/tags/v1.9"),
            candidate(GitRefSort::Name, 5, "refs/tags/v1.9.1"),
        ];
        sorted.sort();
        let names: Vec<_> = sorted.iter().map(|c| c.full_name.as_str()).collect();
        // A newer commit does not lift `v1.10`, and 10 sorts after 9 rather than before it.
        assert_eq!(
            names,
            ["refs/tags/v1.9", "refs/tags/v1.9.1", "refs/tags/v1.10"]
        );
    }

    /// Confirms the default branch leads both orders, even when it is old and late by name.
    #[test]
    fn default_branch_sorts_first() {
        for sort in [GitRefSort::Recent, GitRefSort::Name] {
            let mut default = candidate(sort, 1, "refs/heads/zeta");
            default.is_default = true;
            let mut sorted = [candidate(sort, 9, "refs/heads/alpha"), default];
            sorted.sort();
            // Neither a newer commit nor an earlier name moves a branch above the default.
            assert_eq!(sorted[0].full_name, "refs/heads/zeta", "{sort:?}");
        }
    }

    /// Confirms the details of reading names naturally.
    #[test]
    fn natural_names_compare_numbers_by_value_and_letters_without_case() {
        // Leading zeros do not make a number larger.
        assert_eq!(compare_natural("v010", "v9"), Ordering::Greater);
        // A run longer than u64 still compares by value.
        assert_eq!(
            compare_natural("build-99999999999999999999", "build-100000000000000000000"),
            Ordering::Less
        );
        // Case does not separate otherwise equal letters.
        assert_eq!(compare_natural("Feature", "feature"), Ordering::Equal);
        assert_eq!(compare_natural("alpha", "Beta"), Ordering::Less);
        // A prefix sorts before the longer name.
        assert_eq!(compare_natural("main", "main-2"), Ordering::Less);
        // Local branches lead remote-tracking ones because the namespace is compared too.
        assert_eq!(
            compare_natural("refs/heads/zeta", "refs/remotes/origin/alpha"),
            Ordering::Less
        );
    }

    /// Confirms rows drop only the namespace a ref lives in.
    #[test]
    fn short_names_drop_the_ref_namespace() {
        // Remote branches keep their remote, like `git branch -r`.
        assert_eq!(short_name("refs/remotes/origin/main"), "origin/main");
        // Tags and local branches show their bare names.
        assert_eq!(short_name("refs/tags/v1"), "v1");
        assert_eq!(short_name("refs/heads/feature/x"), "feature/x");
    }
}
