use super::PtySpawnConfig;
use anyhow::{Context, Result, ensure};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    fs::File,
    io::{self, Read, Write},
    os::windows::{
        ffi::OsStrExt,
        io::{FromRawHandle, OwnedHandle},
    },
    ptr::{null, null_mut},
    sync::Mutex,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, STILL_ACTIVE},
    Security::SECURITY_ATTRIBUTES,
    System::{
        Console::{COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole},
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        },
        Pipes::CreatePipe,
        Threading::{
            CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
            EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE,
            InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, STARTF_USESTDHANDLES,
            STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
        },
    },
};

struct ConPtyState {
    hpc: HPCON,
    process: Option<OwnedHandle>,
    _job: Option<OwnedHandle>,
}

// Win32 HANDLE and HPCON are process-wide kernel handles safe to transfer across threads.
unsafe impl Send for ConPtyState {}

pub(super) struct PtyHandle {
    state: Mutex<ConPtyState>,
}

impl PtyHandle {
    pub(super) fn spawn(
        config: PtySpawnConfig,
    ) -> Result<(Self, Box<dyn Read + Send>, Box<dyn Write + Send>)> {
        let mut pty_in_read: HANDLE = null_mut();
        let mut pty_in_write: HANDLE = null_mut();
        let mut pty_out_read: HANDLE = null_mut();
        let mut pty_out_write: HANDLE = null_mut();

        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 0,
        };
        if unsafe { CreatePipe(&mut pty_in_read, &mut pty_in_write, &sa, 0) } == 0 {
            return Err(io::Error::last_os_error()).context("创建 Windows ConPTY 输入管道失败");
        }
        if unsafe { CreatePipe(&mut pty_out_read, &mut pty_out_write, &sa, 0) } == 0 {
            unsafe {
                CloseHandle(pty_in_read);
                CloseHandle(pty_in_write);
            }
            return Err(io::Error::last_os_error()).context("创建 Windows ConPTY 输出管道失败");
        }

        let size = COORD {
            X: config.cols.clamp(1, i16::MAX as u16) as i16,
            Y: config.rows.clamp(1, i16::MAX as u16) as i16,
        };
        let mut hpc: HPCON = 0;
        let hr = unsafe { CreatePseudoConsole(size, pty_in_read, pty_out_write, 0, &mut hpc) };
        unsafe {
            CloseHandle(pty_in_read);
            CloseHandle(pty_out_write);
        }
        if hr != 0 {
            unsafe {
                CloseHandle(pty_in_write);
                CloseHandle(pty_out_read);
            }
            anyhow::bail!("创建 Windows ConPTY 失败 (HRESULT 0x{:08x})", hr as u32);
        }

        let writer = unsafe { File::from_raw_handle(pty_in_write) };
        let reader = unsafe { File::from_raw_handle(pty_out_read) };

        let mut attr_size: usize = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attr_size);
        }
        ensure!(attr_size > 0, "初始化 Windows ConPTY 属性列表失败");
        let mut attr_buf = vec![0u8; attr_size];
        let attr_list = attr_buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        if unsafe { InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_size) } == 0 {
            unsafe { ClosePseudoConsole(hpc) };
            return Err(io::Error::last_os_error()).context("初始化 Windows ConPTY 属性列表失败");
        }
        struct AttrListGuard(LPPROC_THREAD_ATTRIBUTE_LIST);
        impl Drop for AttrListGuard {
            fn drop(&mut self) {
                unsafe { DeleteProcThreadAttributeList(self.0) };
            }
        }
        let _attr_guard = AttrListGuard(attr_list);

        if unsafe {
            UpdateProcThreadAttribute(
                attr_list,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                hpc as *const std::ffi::c_void,
                std::mem::size_of::<HPCON>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            unsafe { ClosePseudoConsole(hpc) };
            return Err(io::Error::last_os_error()).context("绑定 Windows ConPTY 控制台失败");
        }

        let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        // Prevent the child from inheriting redirected parent stdio pipes instead of the ConPTY.
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.lpAttributeList = attr_list;

        let mut cmdline = build_command_line(&config.program, &config.args);
        let cwd_wide = wide_null(config.cwd.as_os_str());
        let env_block = build_environment_block(&config.extra_env);

        let mut proc_info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            CreateProcessW(
                null(),
                cmdline.as_mut_ptr(),
                null(),
                null(),
                0,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                env_block.as_ptr().cast(),
                cwd_wide.as_ptr(),
                &startup.StartupInfo,
                &mut proc_info,
            )
        };
        if ok == 0 {
            unsafe { ClosePseudoConsole(hpc) };
            return Err(io::Error::last_os_error())
                .with_context(|| format!("启动 Windows 终端进程失败: {}", config.program));
        }

        if !proc_info.hThread.is_null() && proc_info.hThread != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(proc_info.hThread) };
        }
        let process = unsafe { OwnedHandle::from_raw_handle(proc_info.hProcess) };
        let job = attach_kill_on_close_job(proc_info.hProcess);

        Ok((
            Self {
                state: Mutex::new(ConPtyState {
                    hpc,
                    process: Some(process),
                    _job: job,
                }),
            },
            Box::new(reader),
            Box::new(writer),
        ))
    }

    pub(super) fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let state = self.state.lock().expect("conpty mutex");
        if state.hpc == 0 {
            return Ok(());
        }
        let size = COORD {
            X: cols.clamp(1, i16::MAX as u16) as i16,
            Y: rows.clamp(1, i16::MAX as u16) as i16,
        };
        let hr = unsafe { ResizePseudoConsole(state.hpc, size) };
        ensure!(hr == 0, "调整 Windows ConPTY 尺寸失败 (0x{:08x})", hr as u32);
        Ok(())
    }

    pub(super) fn wait_exit(&self) -> Option<i32> {
        let cloned = {
            let state = self.state.lock().expect("conpty mutex");
            state
                .process
                .as_ref()
                .and_then(|handle| handle.try_clone().ok())
        }?;
        let raw = std::os::windows::io::AsRawHandle::as_raw_handle(&cloned);
        unsafe {
            WaitForSingleObject(raw, INFINITE);
        }
        let mut code: u32 = 0;
        let ok = unsafe { GetExitCodeProcess(raw, &mut code) };
        if ok != 0 && code != STILL_ACTIVE as u32 {
            Some(code as i32)
        } else {
            None
        }
    }

    pub(super) fn kill(&self) {
        let mut state = self.state.lock().expect("conpty mutex");
        if let Some(process) = state.process.take() {
            let raw = std::os::windows::io::AsRawHandle::as_raw_handle(&process);
            unsafe {
                TerminateProcess(raw, 1);
            }
            drop(process);
        }
        state._job = None;
        if state.hpc != 0 {
            let hpc = state.hpc;
            state.hpc = 0;
            unsafe {
                ClosePseudoConsole(hpc);
            }
        }
    }
}

impl Drop for PtyHandle {
    fn drop(&mut self) {
        self.kill();
    }
}

fn attach_kill_on_close_job(process: HANDLE) -> Option<OwnedHandle> {
    let job = unsafe { CreateJobObjectW(null(), null()) };
    if job.is_null() {
        return None;
    }
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let ok = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if ok == 0 || unsafe { AssignProcessToJobObject(job, process) } == 0 {
        unsafe { CloseHandle(job) };
        return None;
    }
    Some(unsafe { OwnedHandle::from_raw_handle(job) })
}

fn wide_null(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain([0]).collect()
}

fn build_command_line(program: &str, args: &[String]) -> Vec<u16> {
    let mut parts = Vec::with_capacity(args.len() + 1);
    parts.push(quote_windows_arg(program));
    for arg in args {
        parts.push(quote_windows_arg(arg));
    }
    let line = parts.join(" ");
    line.encode_utf16().chain([0]).collect()
}

fn quote_windows_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|c| c == ' ' || c == '\t' || c == '"') {
        return arg.to_owned();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for ch in arg.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                for _ in 0..(backslashes * 2 + 1) {
                    out.push('\\');
                }
                out.push('"');
                backslashes = 0;
            }
            _ => {
                for _ in 0..backslashes {
                    out.push('\\');
                }
                backslashes = 0;
                out.push(ch);
            }
        }
    }
    for _ in 0..(backslashes * 2) {
        out.push('\\');
    }
    out.push('"');
    out
}

fn build_environment_block(extra: &[(String, String)]) -> Vec<u16> {
    let mut merged: BTreeMap<String, (String, String)> = BTreeMap::new();
    for (key, value) in std::env::vars() {
        merged.insert(key.to_ascii_uppercase(), (key, value));
    }
    let defaults = [
        ("TERM", "xterm-256color".to_owned()),
        ("COLORTERM", "truecolor".to_owned()),
        ("TERM_PROGRAM", "FablePavilion".to_owned()),
        ("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION").to_owned()),
        ("WT_SESSION", uuid::Uuid::new_v4().to_string()),
    ];
    for (key, value) in defaults {
        merged.insert(key.to_ascii_uppercase(), (key.to_owned(), value));
    }
    for (key, value) in extra {
        merged.insert(key.to_ascii_uppercase(), (key.clone(), value.clone()));
    }
    let mut block = Vec::new();
    for (_, (key, value)) in merged {
        block.extend(key.encode_utf16());
        block.push(b'=' as u16);
        block.extend(value.encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}
