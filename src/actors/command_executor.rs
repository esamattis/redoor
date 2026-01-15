use crate::commands::{Command, CommandHandler, CommandResult};
use ractor::{Actor, ActorProcessingErr, ActorRef, RpcReplyPort};

pub struct CommandExecutorActor;

pub struct CommandExecutorState;

pub enum CommandExecutorMsg {
    ExecuteCommand {
        command: Command,
        reply_to: RpcReplyPort<CommandResult>,
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
            CommandExecutorMsg::ExecuteCommand { command, reply_to } => {
                let handler = CommandHandler::new();
                let result = handler.execute(command).await;
                let _ = reply_to.send(result);
            }
        }
        Ok(())
    }
}
