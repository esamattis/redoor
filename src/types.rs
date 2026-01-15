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
    },
    #[serde(rename = "agent_unregister")]
    AgentUnregister { agent_id: String },
    #[serde(rename = "agent_list")]
    AgentList { agents: HashMap<String, String> },
    #[serde(rename = "command")]
    Command {
        agent_id: String,
        command: crate::commands::Command,
    },
    #[serde(rename = "command_response")]
    CommandResponse {
        agent_id: String,
        result: crate::commands::CommandResult,
    },
    #[serde(rename = "error")]
    Error { message: String },
}

pub type AgentSender = mpsc::UnboundedSender<Message>;
