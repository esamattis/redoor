use crate::commands::CommandHandler;
use ractor::{Actor, ActorProcessingErr, ActorRef, RpcReplyPort};
use serde_json::Value;

pub struct CommandExecutorActor;

pub struct CommandExecutorState;

pub enum CommandExecutorMsg {
    ExecuteCommand {
        command: String,
        args: Vec<String>,
        reply_to: RpcReplyPort<Value>,
    },
}

impl Actor for CommandExecutorActor {
    type Msg = CommandExecutorMsg;
    type State = CommandExecutorState;
    type Arguments = ();

    async fn pre_start(
        &self,
        _myself: ActorRef<Self::Msg>,
        _args: Self::Arguments,
    ) -> Result<Self::State, ActorProcessingErr> {
        Ok(CommandExecutorState)
    }

    async fn handle(
        &self,
        _myself: ActorRef<Self::Msg>,
        message: Self::Msg,
        _state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        match message {
            CommandExecutorMsg::ExecuteCommand {
                command,
                args,
                reply_to,
            } => {
                let handler = CommandHandler::new();
                let result = handler.execute(&command, &args).await;
                let _ = reply_to.send(result);
            }
        }
        Ok(())
    }
}
