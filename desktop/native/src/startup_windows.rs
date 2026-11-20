use anyhow::{Context, Result};
use auto_launch::{AutoLaunch, WindowsEnableMode};
use windows_registry::CURRENT_USER;

const NAME: &str = "agent-space-native";
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const NOT_FOUND: i32 = 0x8007_0002_u32 as i32;
const INVALID_DATA: i32 = 0x8007_000d_u32 as i32;

pub struct Startup {
    entry: AutoLaunch,
    command: String,
    legacy_command: String,
}

pub fn startup() -> Result<Startup> {
    let path = std::env::current_exe()?;
    let path = path.to_str().context("无法表示适配器路径")?;
    let quoted = format!("\"{path}\"");
    Ok(Startup {
        entry: AutoLaunch::new(
            NAME,
            &quoted,
            WindowsEnableMode::CurrentUser,
            &["--background"],
        ),
        command: format!("{quoted} --background"),
        legacy_command: format!("{path} --background"),
    })
}

impl Startup {
    pub fn is_enabled(&self) -> Result<bool> {
        // The entry may still point to a previously used portable copy.
        Ok(
            registered_command()?.is_some_and(|value| value == self.command)
                && self.entry.is_enabled()?,
        )
    }

    pub fn enable(&self) -> Result<()> {
        Ok(self.entry.enable()?)
    }

    pub fn disable(&self) -> Result<()> {
        match CURRENT_USER
            .options()
            .write()
            .open(RUN_KEY)
            .and_then(|key| key.remove_value(NAME))
        {
            Ok(()) => Ok(()),
            Err(error) if error.code().0 == NOT_FOUND => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

pub fn repair_startup() -> Result<()> {
    let entry = startup()?;
    if registered_command()?.is_some_and(|value| value == entry.legacy_command) {
        // Keep the existing Windows Startup Apps preference when fixing the command.
        CURRENT_USER
            .options()
            .write()
            .open(RUN_KEY)?
            .set_string(NAME, &entry.command)?;
    }
    Ok(())
}

fn registered_command() -> Result<Option<String>> {
    match CURRENT_USER
        .open(RUN_KEY)
        .and_then(|key| key.get_string(NAME))
    {
        Ok(command) => Ok(Some(command)),
        Err(error) if matches!(error.code().0, NOT_FOUND | INVALID_DATA) => Ok(None),
        Err(error) => Err(error.into()),
    }
}
