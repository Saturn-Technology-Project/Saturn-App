//! The built-in skills. Each one is its own object; this only chooses which to run.
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;

use saturn_domain::Arguments;
use saturn_domain::skills::plan::TaskPlan;
use saturn_domain::skills::workspace::Workspace;
use serde_json::json;

use crate::code::{CodeOptions, code_output, code_stop, run_code};
use crate::file::{FileCheckpoint, FileSkill};
use crate::web::WebSkill;
use crate::{ToolResult, either};

const DIRECT_SKILLS: &[&str] = &[
    "files",
    "code",
    "code_output",
    "code_stop",
    "mcp",
    "web",
    "multi_step",
    "delegate",
    "skill",
];

/// What a call to another tool returns.
pub type CallFuture<'a> = Pin<Box<dyn Future<Output = ToolResult> + Send + 'a>>;

/// Calls a tool on another MCP server.
pub trait ToolCaller: Send + Sync {
    /// Runs the tool.
    fn call<'a>(&'a self, tool: &'a str, arguments: Arguments) -> CallFuture<'a>;
}

/// The built-in skills of one run.
#[derive(Clone)]
pub struct GeneralSkills {
    workspace: Workspace,
    files: FileSkill,
    web: WebSkill,
    options: CodeOptions,
    caller: Option<Arc<dyn ToolCaller>>,
}

impl GeneralSkills {
    /// The skills for a run in `workdir`, the project folder the chat works in; without one, the agent's private sandbox.
    pub fn new(
        data_dir: &Path,
        workdir: Option<&Path>,
        caller: Option<Arc<dyn ToolCaller>>,
        checkpoint: Option<Arc<dyn FileCheckpoint>>,
        options: CodeOptions,
    ) -> Self {
        let workspace = match workdir {
            Some(folder) => Workspace::new(folder),
            None => Workspace::new(data_dir.join("workspace")),
        };
        Self {
            files: FileSkill::new(workspace.clone(), checkpoint),
            web: WebSkill::default(),
            workspace,
            options,
            caller,
        }
    }

    /// The same skills with another `web` tool.
    #[must_use]
    pub fn with_web(mut self, web: WebSkill) -> Self {
        self.web = web;
        self
    }

    /// Runs one tool call.
    pub async fn run(&self, tool: &str, arguments: &Arguments) -> ToolResult {
        match tool {
            "files" => self.files.run(arguments).await,
            "code" => run_code(&self.workspace, arguments, &self.options).await,
            "code_output" => code_output(arguments, &self.options).await,
            "code_stop" => code_stop(arguments, &self.options),
            "web" => self.web.run(arguments).await,
            "multi_step" => {
                let plan = TaskPlan::from_arguments(arguments)?;
                Ok(json!({ "explanation": plan.explanation, "steps": plan.steps }))
            }
            "mcp" => self.call_mcp(arguments).await,
            other => Err(format!("Unknown skill: {other}")),
        }
    }

    async fn call_mcp(&self, arguments: &Arguments) -> ToolResult {
        let tool = either(arguments, "tool", "toolId");
        if tool.is_empty() {
            return Err("Name the MCP tool to call".to_owned());
        }
        if DIRECT_SKILLS.contains(&tool.as_str()) {
            return Err("Call that skill directly".to_owned());
        }
        let caller = self
            .caller
            .as_ref()
            .ok_or("No other MCP server is enabled")?;
        let nested = arguments
            .get("arguments")
            .and_then(serde_json::Value::as_object)
            .cloned()
            .unwrap_or_default();
        caller.call(&tool, nested).await
    }
}
