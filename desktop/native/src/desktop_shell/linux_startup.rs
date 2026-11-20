use super::{APP_ID, APP_NAME_EN, APP_NAME_ZH, desktop_exec, write_if_changed};
use anyhow::{Context, Result};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

const FILE_NAME: &str = "autostart/agent-space-native.desktop";

pub struct Startup {
    entry: PathBuf,
    legacy: Option<PathBuf>,
    executable: String,
    exec: String,
}

pub fn startup() -> Result<Startup> {
    let config = dirs::config_dir().context("无法定位桌面自启动目录")?;
    let legacy_config = dirs::home_dir().map(|home| home.join(".config"));
    let executable = std::env::current_exe()?;
    Startup::new(&config, legacy_config.as_deref(), &executable)
}

impl Startup {
    fn new(config: &Path, legacy_config: Option<&Path>, executable: &Path) -> Result<Self> {
        let executable = executable.to_str().context("无法表示适配器路径")?;
        Ok(Self {
            entry: config.join(FILE_NAME),
            legacy: legacy_config
                .filter(|legacy| *legacy != config)
                .map(|legacy| legacy.join(FILE_NAME)),
            executable: executable.to_owned(),
            exec: format!("Exec={} --background", desktop_exec(executable)?),
        })
    }

    pub fn enable(&self) -> Result<()> {
        let content = format!(
            "[Desktop Entry]\nType=Application\nName={APP_NAME_EN}\nName[zh]={APP_NAME_ZH}\n{}\nIcon={APP_ID}\nTerminal=false\nStartupNotify=false\n",
            self.exec
        );
        write_if_changed(&self.entry, content.as_bytes())?;
        Ok(())
    }

    pub fn disable(&self) -> Result<()> {
        // Clear the old location first so it cannot re-enable a disabled entry.
        for path in self.legacy.iter().chain([&self.entry]) {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error).context("无法移除登录自启动入口"),
            }
        }
        Ok(())
    }

    pub fn is_enabled(&self) -> Result<bool> {
        Ok(self.contents()?.is_some_and(|content| enabled(&content)))
    }

    pub fn refresh(&self) -> Result<()> {
        let Some(content) = self.contents()?.filter(|content| enabled(content)) else {
            return Ok(());
        };
        // Refresh generated defaults while preserving user labels and settings.
        let old_exec = format!("Exec={} --background", self.executable);
        let name = format!("Name={APP_NAME_EN}");
        let name_en = format!("Name[en]={APP_NAME_EN}");
        let has_chinese_name = desktop_entry_lines(&content).any(|line| {
            line.split_once('=')
                .is_some_and(|(key, _)| key.trim() == "Name[zh]")
        });
        let mut updated = String::with_capacity(content.len());
        let mut in_desktop_entry = false;
        for line in content.split_inclusive('\n') {
            let value = line.trim_end_matches(['\r', '\n']);
            if value.trim_start().starts_with('[') {
                in_desktop_entry = value.trim() == "[Desktop Entry]";
            }
            if !in_desktop_entry {
                updated.push_str(line);
                continue;
            }
            let ending = &line[value.len()..];
            match value {
                "Name=Agent 空间适配器" => {
                    updated.push_str(&name);
                    if !has_chinese_name {
                        updated.push_str(if ending.is_empty() { "\n" } else { ending });
                        updated.push_str(&format!("Name[zh]={APP_NAME_ZH}"));
                    }
                }
                "Name[en]=Agent Space Adapter" => updated.push_str(&name_en),
                value if value == old_exec => updated.push_str(&self.exec),
                value => updated.push_str(value),
            }
            updated.push_str(ending);
        }
        write_if_changed(&self.entry, updated.as_bytes())?;
        Ok(())
    }

    fn contents(&self) -> Result<Option<String>> {
        for path in [&self.entry].into_iter().chain(self.legacy.iter()) {
            match fs::read_to_string(path) {
                Ok(content) => return Ok(Some(content)),
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error).context("无法读取登录自启动入口"),
            }
        }
        Ok(None)
    }
}

fn desktop_entry_lines(content: &str) -> impl Iterator<Item = &str> {
    content
        .lines()
        .map(str::trim)
        .skip_while(|line| *line != "[Desktop Entry]")
        .skip(1)
        .take_while(|line| !line.starts_with('['))
}

fn enabled(content: &str) -> bool {
    content.lines().any(|line| line.trim() == "[Desktop Entry]")
        && !desktop_entry_lines(content).any(|line| {
            line.split_once('=').is_some_and(|(key, value)| {
                matches!(
                    (key.trim(), value.trim()),
                    ("Hidden", "true") | ("X-GNOME-Autostart-enabled", "false")
                )
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_enabled_entry_to_xdg_config_and_fixes_unquoted_path() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let config = temp.path().join("custom");
        let legacy = temp.path().join(".config");
        let executable = Path::new("/opt/Agent Space/agent-space-native");
        let startup = Startup::new(&config, Some(&legacy), executable)?;
        let legacy_entry = legacy.join(FILE_NAME);
        write_if_changed(
            &legacy_entry,
            "[Desktop Entry]\nType=Application\nName=Agent 空间适配器\nName[en]=Agent Space Adapter\nName[de]=Mein Adapter\nExec=/opt/Agent Space/agent-space-native --background\nX-GNOME-Autostart-Delay=5\n".as_bytes(),
        )?;

        assert!(startup.is_enabled()?);
        startup.refresh()?;
        let content = fs::read_to_string(config.join(FILE_NAME))?;
        assert!(content.contains("Exec=\"/opt/Agent Space/agent-space-native\" --background\n"));
        assert!(content.contains("X-GNOME-Autostart-Delay=5\n"));
        assert!(content.contains("Name=Fable Pavilion Adapter\nName[zh]=子虚亭适配器\n"));
        assert!(content.contains("Name[en]=Fable Pavilion Adapter\n"));
        assert!(content.contains("Name[de]=Mein Adapter\n"));

        startup.disable()?;
        assert!(!startup.is_enabled()?);
        assert!(!legacy_entry.exists());
        startup.enable()?;
        assert!(startup.is_enabled()?);
        assert!(
            fs::read_to_string(&startup.entry)?
                .contains("Name=Fable Pavilion Adapter\nName[zh]=子虚亭适配器\n")
        );
        Ok(())
    }

    #[test]
    fn refresh_preserves_custom_labels_and_other_groups() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let startup = Startup::new(temp.path(), None, Path::new("/opt/agent-space-native"))?;
        let original = "[Desktop Entry]\r\nType=Application\r\nName=Agent 空间适配器\r\nName[zh]=我的适配器\r\nName[en]=My Adapter\r\n[Desktop Action Custom]\r\nName=Agent 空间适配器\r\n";
        write_if_changed(&startup.entry, original.as_bytes())?;
        startup.refresh()?;
        assert_eq!(
            fs::read_to_string(&startup.entry)?,
            original.replacen("Name=Agent 空间适配器", "Name=Fable Pavilion Adapter", 1)
        );
        Ok(())
    }

    #[test]
    fn keeps_disabled_registration_and_does_not_enable_new_installation() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let executable = Path::new("/opt/agent-space-native");
        let startup = Startup::new(temp.path(), None, executable)?;

        startup.refresh()?;
        assert!(!startup.entry.exists());
        for setting in ["Hidden=true", "X-GNOME-Autostart-enabled=false"] {
            let content = format!("[Desktop Entry]\n{setting}\n");
            write_if_changed(&startup.entry, content.as_bytes())?;
            startup.refresh()?;
            assert!(!startup.is_enabled()?);
            assert_eq!(fs::read_to_string(&startup.entry)?, content);
        }
        Ok(())
    }
}
