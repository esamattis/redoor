use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Message {
    #[serde(rename = "agent_register")]
    AgentRegister {
        agent_id: String,
        agent_name: String,
        os: String,
        arch: String,
        hostname: String,
        username: String,
    },
    #[serde(rename = "agent_unregister")]
    AgentUnregister { agent_id: String },
    #[serde(rename = "agent_list")]
    AgentList { agents: HashMap<String, String> },
    #[serde(rename = "command")]
    Command {
        agent_id: String,
        request_id: u64,
        command: crate::commands::Command,
    },
    #[serde(rename = "command_response")]
    CommandResponse {
        agent_id: String,
        request_id: u64,
        result: crate::commands::CommandResult,
    },
    #[serde(rename = "error")]
    Error { message: String },
}

pub type AgentSender = mpsc::UnboundedSender<Message>;
