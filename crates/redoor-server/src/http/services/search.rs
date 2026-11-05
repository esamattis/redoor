//! Path and content searches for the streaming routes, the JSON routes and MCP.
//!
//! Every search runs on the agent as an output stream of NDJSON events that ends with a
//! `done` line. The streaming routes pass those lines through to the browser; the JSON routes
//! and MCP collect them here into one response. There is therefore one search
//! implementation, and the JSON shape is just the stream folded up.

use super::output::{AgentStreamError, OutputStream};
use crate::actors::router::{OutputStreamTracking, RouterHandle};
use crate::http::agent_client::AGENT_LIMIT_MARGIN;
use crate::http::error::ApiError;
use axum::{body::Body, http::header, response::Response};
use redoor_protocol::{
    api::search::{
        ContentGrepEvent, ContentGrepResponse, FileSearchEvent, FileSearchRanking,
        FileSearchResponse, FindRequest, GrepRequest,
    },
    ids::AgentId,
    wire::{command::Command, request},
};
use serde::de::DeserializeOwned;
use std::marker::PhantomData;
use std::time::Duration;
use tokio::time::Instant;

/// Longest NDJSON line the collector accepts. A content match is bounded by its line and
/// context limits to far less, so a longer line means a broken or hostile agent, and the cap
/// keeps it from growing server memory without bound.
const MAX_LINE_BYTES: usize = 1024 * 1024;

/// One admitted search whose agent passed validation, read as events of type `E`.
pub(crate) struct AgentSearch<E> {
    output: OutputStream,
    /// When a collecting caller gives up; the agent's own deadline plus slack, so its timed
    /// out `done` normally arrives first.
    deadline: Instant,
    timeout: Duration,
    events: PhantomData<E>,
}

impl AgentSearch<FileSearchEvent> {
    /// Starts a path search below `path`.
    pub(crate) async fn files(
        router: &RouterHandle,
        agent_id: AgentId,
        path: String,
        search: FindRequest,
    ) -> Result<Self, ApiError> {
        let timeout_seconds = search.timeout;
        let command = Command::FileSearch(request::FileSearch {
            path,
            query: search.query,
            timeout_seconds,
            include_hidden: search.include_hidden,
            respect_gitignore: search.respect_gitignore,
            case_sensitivity: search.case_sensitivity,
            directories_only: search.directories_only,
        });
        Self::open(router, agent_id, command, timeout_seconds).await
    }

    /// Reads the whole stream into the JSON response, keeping the best matches the same way
    /// the agent does, so the result equals the agent's own final list.
    pub(crate) async fn collect(self) -> Result<FileSearchResponse, ApiError> {
        let mut ranking = FileSearchRanking::default();
        let mut summary = None;
        self.read_events(|event| match event {
            FileSearchEvent::Match { entry } => {
                ranking.offer(entry);
                false
            }
            FileSearchEvent::Done {
                timed_out,
                duration_ms,
            } => {
                summary = Some((timed_out, duration_ms));
                true
            }
        })
        .await?;
        let (timed_out, duration_ms) = summary.ok_or(ApiError::Unexpected(SEARCHING_FILES))?;
        Ok(FileSearchResponse {
            results: ranking.into_entries(),
            timed_out,
            duration_ms,
        })
    }
}

impl AgentSearch<ContentGrepEvent> {
    /// Starts a content search below `path`.
    pub(crate) async fn contents(
        router: &RouterHandle,
        agent_id: AgentId,
        path: String,
        search: GrepRequest,
    ) -> Result<Self, ApiError> {
        let timeout_seconds = search.timeout;
        let command = Command::ContentGrep(request::ContentGrep {
            path,
            query: search.query,
            timeout_seconds,
            include_hidden: search.include_hidden,
            respect_gitignore: search.respect_gitignore,
            fixed_string: search.fixed_string,
            case_sensitivity: search.case_sensitivity,
            before_context: search.before_context,
            after_context: search.after_context,
        });
        Self::open(router, agent_id, command, timeout_seconds).await
    }

    /// Reads the whole stream into the JSON response, matches in the order found.
    pub(crate) async fn collect(self) -> Result<ContentGrepResponse, ApiError> {
        let mut results = Vec::new();
        let mut response = None;
        self.read_events(|event| match event {
            ContentGrepEvent::Match { entry } => {
                results.push(entry);
                false
            }
            ContentGrepEvent::Done {
                timed_out,
                cancelled,
                truncated,
                omitted_long_lines,
                duration_ms,
            } => {
                response = Some(ContentGrepResponse {
                    results: Vec::new(),
                    timed_out,
                    cancelled,
                    truncated,
                    omitted_long_lines,
                    duration_ms,
                });
                true
            }
        })
        .await?;
        let mut response = response.ok_or(ApiError::Unexpected(SEARCHING_CONTENTS))?;
        response.results = results;
        Ok(response)
    }
}

/// Operator-facing name of a path search, for protocol errors.
const SEARCHING_FILES: &str = "searching files";
/// Operator-facing name of a content search, for protocol errors.
const SEARCHING_CONTENTS: &str = "searching file contents";

impl<E: DeserializeOwned> AgentSearch<E> {
    /// Admits the search and waits for the agent's first frame.
    ///
    /// The agent validates the query and opens the root before it sends anything, so an
    /// early failure arrives here as the stream's error and becomes a proper HTTP status
    /// instead of a body that breaks off after a `200`.
    async fn open(
        router: &RouterHandle,
        agent_id: AgentId,
        command: Command,
        timeout_seconds: u64,
    ) -> Result<Self, ApiError> {
        let timeout = Duration::from_secs(timeout_seconds) + AGENT_LIMIT_MARGIN;
        let deadline = Instant::now() + timeout;
        let mut output =
            OutputStream::open(router, agent_id, command, OutputStreamTracking::Search).await?;
        let first = tokio::time::timeout_at(deadline, output.peek())
            .await
            .map_err(|_| ApiError::Timeout(timeout))?;
        match first {
            Some(Ok(_)) => Ok(Self {
                output,
                deadline,
                timeout,
                events: PhantomData,
            }),
            Some(Err(AgentStreamError(error))) => Err(ApiError::Command {
                kind: error.kind.clone(),
                message: error.message.clone(),
            }),
            None => Err(ApiError::internal("Search ended before it started")),
        }
    }

    /// Answers with the agent's NDJSON lines as they arrive.
    ///
    /// The body ends with an error when the agent fails mid-search, so a client never takes a
    /// partial list for a finished one; it has no `done` line then either. Dropping the body
    /// cancels the search on the agent.
    pub(crate) fn into_response(self) -> Response {
        Response::builder()
            .header(header::CONTENT_TYPE, "application/x-ndjson")
            // Reverse proxies such as nginx would otherwise hold matches back until the
            // search ends, which defeats streaming them.
            .header("X-Accel-Buffering", "no")
            .body(Body::from_stream(self.output))
            .unwrap_or_else(|_| Response::new(Body::empty()))
    }

    /// Feeds every event to `apply` until it reports `done`, which must be the last line.
    ///
    /// Fails when the agent fails, the stream ends without `done`, a line is malformed or too
    /// long, or the deadline passes; dropping the stream on any of these cancels the agent.
    async fn read_events(mut self, mut apply: impl FnMut(E) -> bool) -> Result<(), ApiError> {
        let timeout = self.timeout;
        let read = async {
            let mut lines = LineSplitter::default();
            let mut done = false;
            while let Some(item) = self.output.recv().await {
                let chunk = item.map_err(|AgentStreamError(error)| ApiError::Command {
                    kind: error.kind,
                    message: error.message,
                })?;
                lines.push(&chunk.data, |line| {
                    if done {
                        return Err(ApiError::internal("Search sent data after its end"));
                    }
                    let event = serde_json::from_slice(line)
                        .map_err(|_| ApiError::internal("Search sent a malformed line"))?;
                    done = apply(event);
                    Ok(())
                })?;
                if chunk.is_last {
                    break;
                }
            }
            lines.finish()?;
            if done {
                Ok(())
            } else {
                Err(ApiError::internal("Search ended before completion"))
            }
        };
        tokio::time::timeout_at(self.deadline, read)
            .await
            .map_err(|_| ApiError::Timeout(timeout))?
    }
}

/// Reassembles NDJSON lines from frames, which may split a line anywhere.
#[derive(Default)]
struct LineSplitter {
    /// Start of a line whose newline has not arrived yet.
    partial: Vec<u8>,
}

impl LineSplitter {
    /// Hands every line completed by `data` to `line`, without its newline.
    fn push(
        &mut self,
        mut data: &[u8],
        mut line: impl FnMut(&[u8]) -> Result<(), ApiError>,
    ) -> Result<(), ApiError> {
        while let Some(end) = data.iter().position(|byte| *byte == b'\n') {
            if self.partial.is_empty() {
                Self::check_length(end)?;
                line(&data[..end])?;
            } else {
                Self::check_length(self.partial.len() + end)?;
                self.partial.extend_from_slice(&data[..end]);
                let complete = std::mem::take(&mut self.partial);
                line(&complete)?;
            }
            data = &data[end + 1..];
        }
        Self::check_length(self.partial.len() + data.len())?;
        self.partial.extend_from_slice(data);
        Ok(())
    }

    /// Fails when the stream ended in the middle of a line.
    fn finish(self) -> Result<(), ApiError> {
        if self.partial.is_empty() {
            Ok(())
        } else {
            Err(ApiError::internal("Search ended in the middle of a line"))
        }
    }

    /// Rejects a line over [`MAX_LINE_BYTES`] before it is buffered.
    fn check_length(length: usize) -> Result<(), ApiError> {
        if length > MAX_LINE_BYTES {
            Err(ApiError::internal("Search sent an oversized line"))
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::fake_agent::FakeAgent;
    use redoor_protocol::api::search::{
        ContentGrepMatch, FILE_SEARCH_RESULT_LIMIT, FileSearchEntry,
    };
    use redoor_protocol::ids::RequestId;
    use redoor_protocol::wire::{
        ServerToAgent,
        command::CommandErrorKind,
        partials::CancelReason,
        request::{AgentRequest, CommandOutcome},
        stream::{STREAM_CREDIT_WINDOW_FRAMES, StreamChunk},
    };

    /// A path search request with the given timeout.
    fn find(timeout: u64) -> FindRequest {
        FindRequest {
            query: "target".to_string(),
            timeout,
            include_hidden: false,
            respect_gitignore: true,
            case_sensitivity: Default::default(),
            directories_only: false,
        }
    }

    /// Delivers frames like an agent that respects credit: once its window is spent it waits
    /// for the server's grants, which the consumer sends as it drains.
    #[derive(Default)]
    struct CreditedAgent {
        outstanding: u32,
    }

    impl CreditedAgent {
        /// Delivers one frame; returns any other priority message, such as a cancel, that
        /// arrived instead of credit, and then does not deliver.
        async fn deliver(
            &mut self,
            agent: &mut FakeAgent,
            chunk: StreamChunk,
        ) -> Option<ServerToAgent> {
            if !chunk.is_last {
                while self.outstanding >= STREAM_CREDIT_WINDOW_FRAMES {
                    match agent.next_priority().await {
                        ServerToAgent::Credit { frames, .. } => self.outstanding -= frames,
                        other => return Some(other),
                    }
                }
                self.outstanding += 1;
            }
            agent.deliver(chunk).await;
            None
        }
    }

    /// Waits for the next priority message that is not a credit grant.
    async fn next_non_credit(agent: &mut FakeAgent) -> ServerToAgent {
        loop {
            match agent.next_priority().await {
                ServerToAgent::Credit { .. } => {}
                other => return other,
            }
        }
    }

    /// Starts a path search on the fake agent and answers it with the ready frame.
    async fn started_file_search(
        agent: &mut FakeAgent,
        timeout: u64,
    ) -> (AgentSearch<FileSearchEvent>, RequestId, CreditedAgent) {
        let router = agent.router.clone();
        let agent_id = agent.agent_id.clone();
        let search = tokio::spawn(async move {
            AgentSearch::files(&router, agent_id, "/tmp".to_string(), find(timeout)).await
        });
        let (id, _) = agent.next_command().await;
        let mut credited = CreditedAgent::default();
        credited
            .deliver(agent, StreamChunk::data(id, Vec::new(), false))
            .await;
        let search = search
            .await
            .unwrap()
            .expect("the ready frame starts the search");
        (search, id, credited)
    }

    /// NDJSON lines of the given events.
    fn lines<T: serde::Serialize>(events: &[T]) -> Vec<u8> {
        let mut data = Vec::new();
        for event in events {
            serde_json::to_writer(&mut data, event).unwrap();
            data.push(b'\n');
        }
        data
    }

    /// A path match with the given score.
    fn path_match(index: usize, score: u32) -> FileSearchEvent {
        FileSearchEvent::Match {
            entry: FileSearchEntry {
                name: format!("f{index}"),
                path: format!("/tmp/f{index:03}"),
                file_type: "file".to_string(),
                score,
            },
        }
    }

    /// Verifies lines split across frames are reassembled and only the best matches are
    /// kept, so the JSON response equals the agent's final list.
    #[tokio::test]
    async fn collector_reassembles_lines_and_keeps_the_top_matches() {
        let mut agent = FakeAgent::connect().await;
        let (search, id, mut credited) = started_file_search(&mut agent, 5).await;
        let mut events: Vec<FileSearchEvent> = (0..150)
            .map(|index| path_match(index, (index % 50) as u32))
            .collect();
        events.push(FileSearchEvent::Done {
            timed_out: true,
            duration_ms: 7,
        });
        let data = lines(&events);
        let collected = tokio::spawn(search.collect());
        // Odd frame sizes cut lines in the middle.
        let pieces: Vec<&[u8]> = data.chunks(97).collect();
        for (index, piece) in pieces.iter().enumerate() {
            let is_last = index + 1 == pieces.len();
            let interrupted = credited
                .deliver(&mut agent, StreamChunk::data(id, piece.to_vec(), is_last))
                .await;
            assert!(interrupted.is_none(), "unexpected {interrupted:?}");
        }
        let response = collected.await.unwrap().expect("the search completes");

        // The list keeps the limit, best score first, with the path as tie breaker.
        assert_eq!(response.results.len(), FILE_SEARCH_RESULT_LIMIT);
        assert_eq!(response.results[0].score, 49);
        assert_eq!(response.results[0].path, "/tmp/f049");
        // Each score appears three times, so 33 scores fill 99 places and the last place goes
        // to the score-16 match with the first path.
        assert!(response.results.iter().all(|entry| entry.score >= 16));
        assert_eq!(
            response.results.last().map(|entry| entry.path.as_str()),
            Some("/tmp/f016")
        );
        // The summary comes from the `done` line.
        assert!(response.timed_out);
        assert_eq!(response.duration_ms, 7);
    }

    /// Verifies a stream that ends without `done` is an error, not an empty result.
    #[tokio::test]
    async fn collector_requires_done() {
        let mut agent = FakeAgent::connect().await;
        let (search, id, mut credited) = started_file_search(&mut agent, 5).await;
        let collected = tokio::spawn(search.collect());
        credited
            .deliver(
                &mut agent,
                StreamChunk::data(id, lines(&[path_match(1, 1)]), true),
            )
            .await;

        // A cut-off search must not look like a complete one.
        assert!(collected.await.unwrap().is_err());
    }

    /// Verifies an endless line is rejected at the cap and the agent is told to stop.
    #[tokio::test]
    async fn collector_rejects_an_oversized_line() {
        let mut agent = FakeAgent::connect().await;
        let (search, id, mut credited) = started_file_search(&mut agent, 60).await;
        let collected = tokio::spawn(search.collect());
        let piece = vec![b'x'; 64 * 1024];
        let mut cancel = None;
        // One piece more than the cap allows, unless the server stops the stream first.
        for _ in 0..=MAX_LINE_BYTES / piece.len() {
            cancel = credited
                .deliver(&mut agent, StreamChunk::data(id, piece.clone(), false))
                .await;
            if cancel.is_some() {
                break;
            }
        }
        let result = collected.await.unwrap();
        let cancel = match cancel {
            Some(cancel) => cancel,
            None => next_non_credit(&mut agent).await,
        };

        // Server memory stays bounded however long the agent's line is.
        assert!(result.is_err());
        // The abandoned search stops on the agent instead of running to its deadline.
        assert!(matches!(
            cancel,
            ServerToAgent::Cancel { id: canceled, reason: CancelReason::Canceled } if canceled == id
        ));
    }

    /// Verifies an agent error before the ready frame becomes the HTTP error of the call.
    #[tokio::test]
    async fn early_agent_error_fails_the_open() {
        let mut agent = FakeAgent::connect().await;
        let router = agent.router.clone();
        let agent_id = agent.agent_id.clone();
        let search = tokio::spawn(async move {
            AgentSearch::contents(
                &router,
                agent_id,
                "/missing".to_string(),
                GrepRequest {
                    query: "x".to_string(),
                    timeout: 5,
                    include_hidden: false,
                    respect_gitignore: true,
                    fixed_string: false,
                    case_sensitivity: Default::default(),
                    before_context: 0,
                    after_context: 0,
                },
            )
            .await
        });
        let (id, _) = agent.next_command().await;
        agent
            .respond(
                id,
                CommandOutcome::error(CommandErrorKind::NotFound, "No such directory"),
            )
            .await;
        let Err(error) = search.await.unwrap() else {
            panic!("a failed validation must not start a stream");
        };

        // The agent's kind decides the status, so a missing root is a 404.
        assert_eq!(error.status_code(), axum::http::StatusCode::NOT_FOUND);
        assert_eq!(error.to_string(), "No such directory");
    }

    /// Verifies a failure after matches were sent ends the collected search with the
    /// agent's error, after the matches it already had.
    #[tokio::test]
    async fn mid_search_failure_fails_the_collection() {
        let mut agent = FakeAgent::connect().await;
        let router = agent.router.clone();
        let agent_id = agent.agent_id.clone();
        let search = tokio::spawn(async move {
            AgentSearch::contents(
                &router,
                agent_id,
                "/tmp".to_string(),
                GrepRequest {
                    query: "x".to_string(),
                    timeout: 5,
                    include_hidden: false,
                    respect_gitignore: true,
                    fixed_string: false,
                    case_sensitivity: Default::default(),
                    before_context: 0,
                    after_context: 0,
                },
            )
            .await
        });
        let (id, _) = agent.next_command().await;
        agent
            .deliver(StreamChunk::data(id, Vec::new(), false))
            .await;
        let search = search
            .await
            .unwrap()
            .expect("the ready frame starts the search");
        let collected = tokio::spawn(search.collect());
        let found = ContentGrepEvent::Match {
            entry: ContentGrepMatch {
                path: "/tmp/a".to_string(),
                line_number: 1,
                line: "x".to_string(),
                line_truncated: false,
                before_context: Vec::new(),
                after_context: Vec::new(),
            },
        };
        agent
            .deliver(StreamChunk::data(id, lines(&[found]), false))
            .await;
        agent
            .respond(
                id,
                request::ContentGrep::encode(Err(
                    redoor_protocol::wire::request::CommandError::new(
                        CommandErrorKind::Internal,
                        "disk gone",
                    ),
                )),
            )
            .await;

        let Err(error) = collected.await.unwrap() else {
            panic!("a failed search must not look complete");
        };
        // The agent's reason reaches the caller.
        assert_eq!(error.to_string(), "disk gone");
    }

    /// Verifies the line splitter hands out whole lines across arbitrary frame cuts.
    #[test]
    fn line_splitter_joins_lines_across_frames() {
        let mut splitter = LineSplitter::default();
        let mut seen = Vec::new();
        for piece in [&b"ab"[..], b"c\nd", b"", b"e\n\nf\n"] {
            splitter
                .push(piece, |line| {
                    seen.push(String::from_utf8_lossy(line).into_owned());
                    Ok(())
                })
                .unwrap();
        }
        // Each newline ends exactly one line, including an empty one.
        assert_eq!(seen, ["abc", "de", "", "f"]);
        // Nothing is left over after the final newline.
        assert!(splitter.finish().is_ok());
    }
}
