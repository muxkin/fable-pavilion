use super::PtySpawnConfig;
use anyhow::{Context, Result, ensure};
use std::{
    ffi::CStr,
    fs::File,
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::process::CommandExt,
    },
    process::{Child, Command, Stdio},
    sync::Mutex,
};

pub(super) struct PtyHandle {
    master: OwnedFd,
    child: Mutex<Child>,
    pid: i32,
}

impl PtyHandle {
    pub(super) fn spawn(
        config: PtySpawnConfig,
    ) -> Result<(Self, Box<dyn Read + Send>, Box<dyn Write + Send>)> {
        let master_raw = unsafe { libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY) };
        ensure!(master_raw >= 0, "无法创建终端 PTY: {}", io::Error::last_os_error());
        let master = unsafe { OwnedFd::from_raw_fd(master_raw) };
        set_cloexec(master.as_raw_fd())?;
        if unsafe { libc::grantpt(master.as_raw_fd()) } != 0 {
            return Err(io::Error::last_os_error()).context("无法授权 PTY 从设备");
        }
        if unsafe { libc::unlockpt(master.as_raw_fd()) } != 0 {
            return Err(io::Error::last_os_error()).context("无法解锁 PTY 从设备");
        }
        let slave_name = slave_path(master.as_raw_fd())?;
        let slave_raw = unsafe {
            libc::open(
                slave_name.as_ptr(),
                libc::O_RDWR | libc::O_NOCTTY,
            )
        };
        ensure!(slave_raw >= 0, "无法打开 PTY 从设备: {}", io::Error::last_os_error());
        let slave = unsafe { OwnedFd::from_raw_fd(slave_raw) };
        set_cloexec(slave.as_raw_fd())?;

        set_winsize(master.as_raw_fd(), config.cols, config.rows)?;

        let slave_fd = slave.as_raw_fd();
        let mut command = Command::new(&config.program);
        command
            .args(&config.args)
            .current_dir(&config.cwd)
            .env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor")
            .env("TERM_PROGRAM", "FablePavilion")
            .env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        if std::env::var_os("LANG").is_none() {
            command.env("LANG", "C.UTF-8");
        }
        for (key, value) in &config.extra_env {
            command.env(key, value);
        }
        let stdin_fd = dup_fd(slave_fd)?;
        let stdout_fd = dup_fd(slave_fd)?;
        let stderr_fd = dup_fd(slave_fd)?;
        command
            .stdin(unsafe { Stdio::from_raw_fd(stdin_fd) })
            .stdout(unsafe { Stdio::from_raw_fd(stdout_fd) })
            .stderr(unsafe { Stdio::from_raw_fd(stderr_fd) });

        unsafe {
            command.pre_exec(move || {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                #[allow(clippy::useless_conversion)]
                if libc::ioctl(0, libc::TIOCSCTTY.into(), 0) == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let child = command
            .spawn()
            .with_context(|| format!("无法启动终端进程 {}", config.program))?;
        drop(slave);

        let pid = child.id() as i32;
        let reader_fd = dup_fd(master.as_raw_fd())?;
        let writer_fd = dup_fd(master.as_raw_fd())?;
        set_cloexec(reader_fd)?;
        set_cloexec(writer_fd)?;
        let reader = unsafe { File::from_raw_fd(reader_fd) };
        let writer = unsafe { File::from_raw_fd(writer_fd) };

        Ok((
            Self {
                master,
                child: Mutex::new(child),
                pid,
            },
            Box::new(reader),
            Box::new(writer),
        ))
    }

    pub(super) fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        set_winsize(self.master.as_raw_fd(), cols, rows)
    }

    pub(super) fn wait_exit(&self) -> Option<i32> {
        let mut child = self.child.lock().expect("pty child mutex");
        child
            .wait()
            .ok()
            .and_then(|status| status.code())
    }

    pub(super) fn kill(&self) {
        if self.pid > 0 {
            unsafe {
                let _ = libc::kill(-self.pid, libc::SIGHUP);
            }
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for PtyHandle {
    fn drop(&mut self) {
        self.kill();
    }
}

fn dup_fd(fd: RawFd) -> Result<RawFd> {
    let duplicated = unsafe { libc::dup(fd) };
    ensure!(duplicated >= 0, "复制终端描述符失败: {}", io::Error::last_os_error());
    Ok(duplicated)
}

fn set_cloexec(fd: RawFd) -> Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    ensure!(flags >= 0, "读取终端描述符标志失败");
    ensure!(
        unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } == 0,
        "设置终端 CLOEXEC 失败"
    );
    Ok(())
}

fn set_winsize(fd: RawFd, cols: u16, rows: u16) -> Result<()> {
    let ws = libc::winsize {
        ws_row: rows.max(1),
        ws_col: cols.max(1),
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    #[allow(clippy::useless_conversion)]
    let rc = unsafe { libc::ioctl(fd, libc::TIOCSWINSZ.into(), &ws) };
    ensure!(rc == 0, "调整终端尺寸失败: {}", io::Error::last_os_error());
    Ok(())
}

#[cfg(target_os = "linux")]
fn slave_path(master_fd: RawFd) -> Result<std::ffi::CString> {
    let mut buf = vec![0u8; 256];
    let rc = unsafe { libc::ptsname_r(master_fd, buf.as_mut_ptr().cast(), buf.len()) };
    ensure!(rc == 0, "无法读取 PTY 从设备路径");
    let cstr = CStr::from_bytes_until_nul(&buf).context("PTY 路径无效")?;
    Ok(cstr.to_owned())
}

#[cfg(not(target_os = "linux"))]
fn slave_path(master_fd: RawFd) -> Result<std::ffi::CString> {
    static PTSNAME_LOCK: Mutex<()> = Mutex::new(());
    let _guard = PTSNAME_LOCK.lock().expect("ptsname mutex");
    let ptr = unsafe { libc::ptsname(master_fd) };
    ensure!(!ptr.is_null(), "无法读取 PTY 从设备路径");
    Ok(unsafe { CStr::from_ptr(ptr) }.to_owned())
}
