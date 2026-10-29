//! `redoor remote find` and `redoor remote grep`: the server-side name and content searches
//! the UI uses, so large trees are searched on the device instead of downloaded.

use anyhow::Result;
use clap::{Args, ValueEnum};
use redoor_protocol::api::search::{
    CaseSensitivity, ContentGrepResponse, FileSearchResponse, FindRequest, GrepRequest,
    MAX_GREP_CONTEXT_LINES,
};
use reqwest::Method;

use super::{client::RemoteClient, copy::Location, credentials::CredentialStore};

/// CLI spelling of the shared case-sensitivity policy.
#[derive(Clone, Copy, ValueEnum)]
pub(crate) enum Case {
    /// Case-insensitive unless the query has an uppercase letter.
    Smart,
    /// Exact letter case.
    Sensitive,
    /// Ignore letter case.
    Insensitive,
}

impl From<Case> for CaseSensitivity {
    /// Maps the flag to the API policy without changing its meaning.
    fn from(value: Case) -> Self {
        match value {
            Case::Smart => Self::Smart,
            Case::Sensitive => Self::Sensitive,
            Case::Insensitive => Self::Insensitive,
        }
    }
}

/// Options shared by both searches.
#[derive(Args)]
pub(crate) struct SearchOptions {
    /// Include hidden files and directories.
    #[arg(long)]
    hidden: bool,
    /// Do not skip files ignored by .gitignore.
    #[arg(long)]
    no_ignore: bool,
    /// Letter case matching.
    #[arg(long, value_enum, default_value = "smart")]
    case: Case,
    /// Search deadline in seconds; results found until then are returned.
    #[arg(long, default_value_t = 10)]
    timeout: u64,
    /// Print the API response as JSON.
    #[arg(long)]
    json: bool,
}

/// Arguments of `find`.
#[derive(Args)]
pub(crate) struct FindArgs {
    /// Directory to search, as DEVICE:/absolute/path.
    root: String,
    /// Substring of the names to find.
    query: String,
    #[command(flatten)]
    options: SearchOptions,
}

/// Arguments of `grep`.
#[derive(Args)]
pub(crate) struct GrepArgs {
    /// Directory to search, as DEVICE:/absolute/path.
    root: String,
    /// Regular expression (or literal text with --fixed-strings).
    pattern: String,
    /// Treat the pattern as literal text.
    #[arg(short = 'F', long)]
    fixed_strings: bool,
    /// Lines of context before and after each match.
    #[arg(short = 'C', long, default_value_t = 0)]
    context: u64,
    #[command(flatten)]
    options: SearchOptions,
}

/// Prints one matching path per line.
pub(crate) async fn find(store: CredentialStore, args: FindArgs) -> Result<()> {
    let root = Location::remote(&args.root).await?;
    let client = RemoteClient::load(&store).await?;
    client.ensure_agent_running(root.agent.as_str()).await?;
    let request = FindRequest {
        query: args.query,
        timeout: args.options.timeout,
        include_hidden: args.options.hidden,
        respect_gitignore: !args.options.no_ignore,
        case_sensitivity: args.options.case.into(),
        directories_only: false,
    };
    let response = client
        .send(client.json_request(Method::POST, &client.agent_path(&root, "find")?, &request)?)
        .await?;
    let found: FileSearchResponse = serde_json::from_slice(&response.bytes().await?)?;
    if args.options.json {
        println!("{}", serde_json::to_string_pretty(&found)?);
        return Ok(());
    }
    for entry in &found.results {
        println!("{}", entry.path.escape_debug());
    }
    if found.timed_out {
        eprintln!("Search timed out; results may be incomplete");
    }
    Ok(())
}

/// Prints matches as `path:line:text`, with `path-line-text` context lines like ripgrep.
pub(crate) async fn grep(store: CredentialStore, args: GrepArgs) -> Result<()> {
    let root = Location::remote(&args.root).await?;
    let client = RemoteClient::load(&store).await?;
    client.ensure_agent_running(root.agent.as_str()).await?;
    let context = args.context.min(MAX_GREP_CONTEXT_LINES);
    let request = GrepRequest {
        query: args.pattern,
        timeout: args.options.timeout,
        include_hidden: args.options.hidden,
        respect_gitignore: !args.options.no_ignore,
        fixed_string: args.fixed_strings,
        case_sensitivity: args.options.case.into(),
        before_context: context,
        after_context: context,
    };
    let response = client
        .send(client.json_request(Method::POST, &client.agent_path(&root, "grep")?, &request)?)
        .await?;
    let found: ContentGrepResponse = serde_json::from_slice(&response.bytes().await?)?;
    if args.options.json {
        println!("{}", serde_json::to_string_pretty(&found)?);
        return Ok(());
    }
    for matched in &found.results {
        let path = matched.path.escape_debug().to_string();
        for line in &matched.before_context {
            println!("{path}-{}-{}", line.line_number, line.line.escape_debug());
        }
        println!(
            "{path}:{}:{}",
            matched.line_number,
            matched.line.escape_debug()
        );
        for line in &matched.after_context {
            println!("{path}-{}-{}", line.line_number, line.line.escape_debug());
        }
    }
    if found.timed_out || found.truncated {
        eprintln!("Search stopped early; results may be incomplete");
    }
    Ok(())
}
