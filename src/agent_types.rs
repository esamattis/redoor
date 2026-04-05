use crate::types::AgentId;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Message {
    #[serde(rename = "agent_register")]
    AgentRegister {
        agent_id: AgentId,
        agent_name: String,
    },
    #[serde(rename = "agent_unregister")]
    AgentUnregister { agent_id: AgentId },
    #[serde(rename = "agent_list")]
    AgentList { agents: HashMap<AgentId, String> },
    #[serde(rename = "command")]
    Command {
        agent_id: AgentId,
        command: String,
        args: Vec<String>,
    },
    #[serde(rename = "command_response")]
    CommandResponse {
        agent_id: AgentId,
        result: serde_json::Value,
    },
    #[serde(rename = "error")]
    Error { message: String },
}
