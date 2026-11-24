use crate::{files::Attachment, queue, requests};
use serde::Deserialize;
use serde_json::Value;
#[cfg(feature = "official-plugins")]
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use uuid::Uuid;

#[cfg(feature = "official-plugins")]
mod desktop;
#[cfg(feature = "official-plugins")]
pub(crate) use desktop::{Desktop, Thread, native_text, native_user_text, ordered, read_frame};

#[cfg(feature = "official-plugins")]
pub(crate) fn delegated_input(tool: &Value, thread: &str) -> Option<String> {
    let name = tool["name"].as_str()?;
    if tool["namespace"] != "codex_app" || !matches!(name, "create_thread" | "send_message_to_thread") {
        return None;
    }
    let wrapper = tool["output"]
        .as_str()?
        .trim()
        .strip_prefix("<codex_delegation>")?
        .strip_suffix("</codex_delegation>")?;
    let (source, mut wrapper) = delegation_field(wrapper, "<source_thread_id>", "</source_thread_id>")?;
    if name == "send_message_to_thread" && source != thread {
        return None;
    }
    let has_orbit = wrapper.starts_with("<source_orbit_id>");
    if has_orbit {
        (_, wrapper) = delegation_field(wrapper, "<source_orbit_id>", "</source_orbit_id>")?;
    }
    let input = wrapper
        .strip_prefix("<input>")?
        .strip_suffix("</input>")?
        .trim();
    let input = if let Some(nested) = input
        .strip_prefix("<codex_delegation_content version=\"1\">")
        .and_then(|value| value.strip_suffix("</codex_delegation_content>"))
    {
        if has_orbit {
            return None;
        }
        let (_, task) = delegation_field(nested, "<source_orbit_id>", "</source_orbit_id>")?;
        task.strip_prefix("<task>")?.strip_suffix("</task>")?
    } else {
        input
    };
    if input.is_empty() || input.contains('<') {
        return None;
    }
    Some(
        input
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&"),
    )
}

#[cfg(feature = "official-plugins")]
fn delegation_field<'a>(input: &'a str, start: &str, end: &str) -> Option<(&'a str, &'a str)> {
    let (field, rest) = input.trim_start().strip_prefix(start)?.split_once(end)?;
    if field.trim().is_empty() || field.contains('<') {
        return None;
    }
    Some((field, rest.trim()))
}

#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Action {
    Send {
        text: String,
        files: Vec<Attachment>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tools: Vec<Value>,
    },
    FirstSend {
        text: String,
        files: Vec<Attachment>,
        tools: Vec<Value>,
    },
    Steer {
        text: String,
        expected: String,
        files: Vec<Attachment>,
    },
    Interrupt {
        expected: String,
    },
    Settings {
        input: Value,
    },
    Permission {
        input: Value,
    },
    Goal {
        change: crate::codex_goal::Change,
    },
    Respond {
        response: requests::Response,
    },
    Queue {
        change: queue::Change,
    },
}

impl Action {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Send { .. } | Self::FirstSend { .. } => "send",
            Self::Steer { .. } => "steer",
            Self::Interrupt { .. } => "interrupt",
            Self::Settings { .. } => "settings",
            Self::Permission { .. } | Self::Goal { .. } => "control",
            Self::Respond { .. } => "respond",
            Self::Queue { change } => change.name(),
        }
    }
}

#[derive(Deserialize, serde::Serialize)]
pub enum Outcome {
    Completed(Option<Uuid>),
    Rejected(String),
    Uncertain,
    Accepted(String),
    Interrupted(String),
}

#[derive(Clone, Deserialize, serde::Serialize)]
pub struct View {
    pub thread: Value,
    pub messages: Vec<Value>,
    #[serde(default)]
    pub(crate) app_tools: bool,
    #[serde(default)]
    pub(crate) app_server: bool,
    #[cfg(feature = "official-plugins")]
    #[serde(skip)]
    pub(crate) native_goal: Option<Value>,
    #[cfg(feature = "official-plugins")]
    #[serde(skip)]
    pub expanded: HashMap<String, String>,
    #[cfg(feature = "official-plugins")]
    #[serde(skip)]
    pub activities: HashMap<String, Value>,
    #[cfg(feature = "official-plugins")]
    #[serde(skip)]
    pub pending: Vec<Value>,
    #[cfg(feature = "official-plugins")]
    #[serde(skip)]
    pub inline: Arc<HashMap<String, String>>,
    #[cfg(feature = "official-plugins")]
    #[serde(skip)]
    pub reply_turns: HashSet<String>,
    pub turns: Vec<Turn>,
    pub epoch: Uuid,
    #[cfg(feature = "official-plugins")]
    #[serde(skip)]
    pub disabled_plugins: Vec<String>,
}

impl View {
    pub(crate) fn is_open(&self) -> bool {
        self.thread["synchronized"] == true
            && self.thread["owner"] == true
            && self.thread["runtimeStatus"] != "notLoaded"
    }

    pub(crate) fn supports_controls(&self) -> bool {
        self.is_open() || self.app_server
    }

    pub(crate) fn is_ready_to_continue(&self) -> bool {
        self.is_open()
            || (self.app_tools
                && self.thread["synchronized"] == true
                && self.thread["canResumeForSend"] == true
                && self.thread["canSend"] == true)
    }

    pub(crate) fn mark(&self) -> (Uuid, u64, Option<String>) {
        (
            self.epoch,
            self.thread["revision"].as_u64().unwrap_or_default(),
            self.thread["queueFingerprint"].as_str().map(str::to_owned),
        )
    }
}

#[derive(Clone, Deserialize, serde::Serialize)]
pub struct Turn {
    pub id: String,
    pub request: Option<String>,
    pub state: String,
}
