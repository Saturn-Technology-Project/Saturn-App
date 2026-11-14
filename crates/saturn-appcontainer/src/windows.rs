//! The Win32 calls an AppContainer is made with. The launcher runs one program and ends with it, so what the system
//! allocates for it here (identities, access lists) is left to the end of the process and not freed one by one.
use std::ffi::c_void;
use std::path::Path;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, GetLastError, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, EXPLICIT_ACCESS_W, GRANT_ACCESS, GetNamedSecurityInfoW,
    NO_MULTIPLE_TRUSTEE, SE_FILE_OBJECT, SetEntriesInAclW, SetNamedSecurityInfoW, TRUSTEE_IS_SID,
    TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_W,
};
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, CreateWellKnownSid, DACL_SECURITY_INFORMATION,
    DeriveCapabilitySidsFromName, EqualSid, GetAce, NO_INHERITANCE, PSECURITY_DESCRIPTOR, PSID,
    SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    WELL_KNOWN_SID_TYPE, WinBuiltinAnyPackageSid, WinCapabilityInternetClientServerSid,
    WinCapabilityInternetClientSid, WinCapabilityPrivateNetworkClientServerSid,
};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::Diagnostics::Debug::{
    SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX, SEM_NOOPENFILEERRORBOX, SetErrorMode,
};
use windows_sys::Win32::System::Environment::{GetCommandLineW, SetEnvironmentVariableW};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess, GetExitCodeProcess, INFINITE,
    InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_INFORMATION, STARTF_USESTDHANDLES,
    STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
};

use crate::{Policy, split_command_line};

/// Reading a file or a folder and running what is in it.
const READ: u32 = 0x0012_00A9;
/// Reading, writing and deleting, without changing who may.
const MODIFY: u32 = 0x0013_01BF;
/// Knowing that a folder is there and what kind of thing it is, without seeing what is in it. Programs ask this of
/// every folder above the one they work in (Node to resolve a script's path, git to find a repository).
const ATTRIBUTES: u32 = 0x0010_0080;
/// An entry of an access list that allows.
const ALLOWS: u8 = 0;
/// A capability that is switched on.
const ENABLED: u32 = 4;

/// Text as the system takes it: UTF-16, ended by a zero.
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The system's last error, as a number to look up.
fn last_error() -> String {
    // SAFETY: reads this thread's error code and nothing else.
    format!("Windows error {}", unsafe { GetLastError() })
}

/// The identity of the container with this name, registered for this user if it is not yet: Windows starts a program
/// only in a container it knows. `forget` takes the registration away again.
fn container(name: &str) -> Result<PSID, String> {
    let name = wide(name);
    let about = wide("A sandbox Saturn runs a command in");
    let mut identity: PSID = null_mut();
    // SAFETY: the texts end in a zero and outlive the call; no capabilities are passed, as counted; `identity` is a
    // place for the pointer the call allocates.
    let made = unsafe {
        CreateAppContainerProfile(
            name.as_ptr(),
            name.as_ptr(),
            about.as_ptr(),
            null(),
            0,
            &mut identity,
        )
    };
    if made >= 0 && !identity.is_null() {
        return Ok(identity);
    }
    // Registered before, by an earlier command with the same policy.
    // SAFETY: as above.
    let known = unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut identity) };
    if known < 0 || identity.is_null() {
        return Err(format!("no container ({made:#x})"));
    }
    Ok(identity)
}

/// Takes a container's registration away, once nothing runs in it. What was opened to it stays in the access lists,
/// naming an identity nothing has any more.
pub fn forget(name: &str) {
    let name = wide(name);
    // SAFETY: `name` ends in a zero and outlives the call.
    unsafe { DeleteAppContainerProfile(name.as_ptr()) };
}

/// The identity of the capability with this name, which sandboxes hold to share folders.
fn capability(name: &str) -> Result<PSID, String> {
    let name = wide(name);
    let (mut groups, mut group_count) = (null_mut::<PSID>(), 0u32);
    let (mut capabilities, mut count) = (null_mut::<PSID>(), 0u32);
    // SAFETY: `name` ends in a zero; the four others are places for what the call allocates and counts.
    let made = unsafe {
        DeriveCapabilitySidsFromName(
            name.as_ptr(),
            &mut groups,
            &mut group_count,
            &mut capabilities,
            &mut count,
        )
    };
    if made == 0 || count == 0 || capabilities.is_null() {
        return Err(format!("no shared capability ({})", last_error()));
    }
    // SAFETY: the call said `capabilities` holds `count` identities, and there is at least one.
    Ok(unsafe { *capabilities })
}

/// One of the system's own identities, such as a network capability, in memory of this program's. Words, not bytes, so it is aligned as an
/// identity must be.
fn well_known(kind: WELL_KNOWN_SID_TYPE) -> Result<Vec<u32>, String> {
    let mut identity = vec![0u32; 17];
    let mut size = 68u32;
    // SAFETY: `identity` is `size` bytes long, the most an identity takes.
    let made =
        unsafe { CreateWellKnownSid(kind, null_mut(), identity.as_mut_ptr().cast(), &mut size) };
    if made == 0 {
        return Err(format!("no well-known identity ({})", last_error()));
    }
    Ok(identity)
}

/// Whether an access list already allows `identity` all of `rights`, by an entry of the path's own or one handed
/// down from the folder above; a folder's entry must also be handed down to what is inside. With no rights asked for,
/// any entry that allows the identity something counts.
///
/// # Safety
/// `list` must be an access list the system returned and has not freed, and `identity` a valid identity.
unsafe fn allowed(list: *const ACL, identity: PSID, rights: u32, folder: bool) -> bool {
    // SAFETY: the caller's `list` is valid, so its count is, and each entry `GetAce` returns lies inside it. Only
    // entries that allow are read, which are a header, a mask and an identity.
    unsafe {
        for index in 0..u32::from((*list).AceCount) {
            let mut entry: *mut c_void = null_mut();
            if GetAce(list, index, &mut entry) == 0 || entry.is_null() {
                continue;
            }
            let header = &*entry.cast::<ACE_HEADER>();
            let handed_down = u32::from(header.AceFlags) & SUB_CONTAINERS_AND_OBJECTS_INHERIT
                == SUB_CONTAINERS_AND_OBJECTS_INHERIT;
            if header.AceType != ALLOWS || (folder && !handed_down) {
                continue;
            }
            let entry = entry.cast::<ACCESS_ALLOWED_ACE>();
            let whose: PSID = (&raw mut (*entry).SidStart).cast();
            if (*entry).Mask & rights == rights && EqualSid(whose, identity) != 0 {
                return true;
            }
        }
    }
    false
}

/// A path's access list, with the descriptor that holds it and has to be freed after it.
fn access_list(path: &str) -> Result<(*mut ACL, PSECURITY_DESCRIPTOR), String> {
    let name = wide(path);
    let mut list: *mut ACL = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: `name` ends in a zero; `list` and `descriptor` are places for what the call allocates.
    let status = unsafe {
        GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut list,
            null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("Windows error {status}"));
    }
    Ok((list, descriptor))
}

/// An identity as text, the way `icacls` takes one.
fn written(identity: PSID) -> Result<String, String> {
    let mut text: *mut u16 = null_mut();
    // SAFETY: `identity` is valid; `text` is a place for the zero-ended text the call allocates.
    unsafe {
        if ConvertSidToStringSidW(identity, &mut text) == 0 || text.is_null() {
            return Err(last_error());
        }
        let mut length = 0;
        while *text.add(length) != 0 {
            length += 1;
        }
        Ok(String::from_utf16_lossy(std::slice::from_raw_parts(
            text, length,
        )))
    }
}

/// Closes a path inside an opened folder to the sandboxes again. An entry that denies a container is not honoured,
/// so the path stops taking its access list from the folder above, keeping a copy of what it had, and the entries for
/// the sandboxes are taken out of the copy. The system's own `icacls` does both, which keeps the copying out of here.
fn close(path: &str, identities: &[PSID]) -> Result<(), String> {
    if !Path::new(path).exists() {
        return Ok(());
    }
    let (list, descriptor) = access_list(path)?;
    // SAFETY: `list` was just returned for this path and is freed only below.
    let open = !list.is_null()
        && identities
            .iter()
            .any(|identity| unsafe { allowed(list, *identity, 0, false) });
    // SAFETY: `descriptor` holds `list`; neither is used again.
    unsafe { LocalFree(descriptor) };
    if !open {
        return Ok(());
    }
    let system = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_owned());
    let icacls = Path::new(&system).join("System32").join("icacls.exe");
    let run = |arguments: &[String]| -> Result<(), String> {
        let done = std::process::Command::new(&icacls)
            .arg(path)
            .args(arguments)
            .arg("/q")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|error| error.to_string())?;
        if done.success() {
            Ok(())
        } else {
            Err(format!("icacls ended with {done}"))
        }
    };
    run(&["/inheritance:d".to_owned()])?;
    let mut remove = vec!["/remove".to_owned()];
    for identity in identities {
        remove.push(format!("*{}", written(*identity)?));
    }
    run(&remove)
}

/// Adds an entry for `identity` to a path's access list, allowing `rights`, handed down to everything inside a
/// folder unless it is for the folder `alone`. A path that is not there, or already allows them, is left as it is.
fn open(path: &str, identity: PSID, rights: u32, alone: bool) -> Result<(), String> {
    if !Path::new(path).exists() {
        return Ok(());
    }
    let folder = !alone && Path::new(path).is_dir();
    let (list, descriptor) = access_list(path)?;
    // What Windows opens to every container, as it does its own folders and most of Program Files, needs no entry.
    let mut every = well_known(WinBuiltinAnyPackageSid)?;
    let every: PSID = every.as_mut_ptr().cast();
    // A path without an access list is open to everyone; giving it one would close it to them.
    // SAFETY: `list` was just returned for this path and is freed only below; both identities are valid.
    let result = if list.is_null()
        || unsafe {
            allowed(list, identity, rights, folder) || allowed(list, every, rights, folder)
        } {
        Ok(())
    } else {
        let entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: rights,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: if folder {
                SUB_CONTAINERS_AND_OBJECTS_INHERIT
            } else {
                NO_INHERITANCE
            },
            Trustee: TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
                ptstrName: identity.cast(),
            },
        };
        let name = wide(path);
        let mut changed: *mut ACL = null_mut();
        // SAFETY: one entry is passed, as counted; `list` is valid; `changed` is a place for the new list.
        let status = unsafe { SetEntriesInAclW(1, &entry, list, &mut changed) };
        if status != ERROR_SUCCESS {
            Err(format!("Windows error {status}"))
        } else {
            // SAFETY: `name` ends in a zero and `changed` is the list the call above made.
            let status = unsafe {
                SetNamedSecurityInfoW(
                    name.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    changed,
                    null(),
                )
            };
            // SAFETY: `changed` was allocated by the system for this program and is not used again.
            unsafe { LocalFree(changed.cast()) };
            if status == ERROR_SUCCESS {
                Ok(())
            } else {
                Err(format!("Windows error {status}"))
            }
        }
    };
    // SAFETY: `descriptor` holds `list`; neither is used again.
    unsafe { LocalFree(descriptor) };
    result
}

/// This program's own command line, as it was written.
fn command_line() -> Vec<u16> {
    // SAFETY: the system keeps the command line for the life of the process, ended by a zero.
    unsafe {
        let start = GetCommandLineW();
        let mut length = 0;
        while *start.add(length) != 0 {
            length += 1;
        }
        std::slice::from_raw_parts(start, length).to_vec()
    }
}

/// Sets a variable the program started next will find.
fn set_variable(name: &str, value: &str) {
    let (name, value) = (wide(name), wide(value));
    // SAFETY: both end in a zero and outlive the call.
    unsafe { SetEnvironmentVariableW(name.as_ptr(), value.as_ptr()) };
}

/// Ties what this program starts to its own life: when the launcher ends, however it ends, Windows ends the program
/// it started and everything that program started. Whoever stops a sandboxed command stops the launcher, and could
/// otherwise miss a program the launcher was only just starting. The job's handle is kept until the process ends,
/// which is what lets go of it.
fn end_together() {
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: the job is new and unnamed; `limits` is the structure the class names, of the size given; the process
    // handle is this process's own, which needs no closing.
    unsafe {
        let job = CreateJobObjectW(null(), null());
        if job.is_null() {
            return;
        }
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()).unwrap_or(0),
        );
        AssignProcessToJobObject(job, GetCurrentProcess());
    }
}

/// Starts the command line in the container, with this program's own input and output, and waits for it.
fn run(
    line: &mut [u16],
    container: PSID,
    capabilities: &mut [SID_AND_ATTRIBUTES],
) -> Result<i32, String> {
    let security = SECURITY_CAPABILITIES {
        AppContainerSid: container,
        // No capabilities is said with no pointer.
        Capabilities: if capabilities.is_empty() {
            null_mut()
        } else {
            capabilities.as_mut_ptr()
        },
        CapabilityCount: u32::try_from(capabilities.len()).unwrap_or(0),
        Reserved: 0,
    };
    let mut size = 0usize;
    // SAFETY: asked with no list, the call only says how large one attribute's list is.
    unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size) };
    // Words, so the list is aligned for the pointers it holds.
    let mut storage = vec![0usize; size.div_ceil(size_of::<usize>()).max(1)];
    let attributes: LPPROC_THREAD_ATTRIBUTE_LIST = storage.as_mut_ptr().cast();
    // SAFETY: `storage` is at least `size` bytes and outlives the list; `security`, with the identities it points to,
    // outlives the process's start, which is all the list is used for.
    let listed = unsafe {
        InitializeProcThreadAttributeList(attributes, 1, 0, &mut size) != 0
            && UpdateProcThreadAttribute(
                attributes,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                (&raw const security).cast(),
                size_of::<SECURITY_CAPABILITIES>(),
                null_mut(),
                null(),
            ) != 0
    };
    if !listed {
        return Err(format!(
            "the container could not be named for the process ({})",
            last_error()
        ));
    }
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = u32::try_from(size_of::<STARTUPINFOEXW>()).unwrap_or(0);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    // SAFETY: asks for this program's own three handles.
    unsafe {
        startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    }
    startup.lpAttributeList = attributes;
    let mut process = PROCESS_INFORMATION::default();
    // SAFETY: `line` ends in a zero and may be written to, as the call requires; `startup` is the extended form the
    // flag announces, and `process` is a place for the handles.
    let started = unsafe {
        CreateProcessW(
            null(),
            line.as_mut_ptr(),
            null(),
            null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
            null(),
            null(),
            &raw const startup.StartupInfo,
            &mut process,
        )
    };
    let failure = last_error();
    // SAFETY: the list was initialised above and is not used after this.
    unsafe { DeleteProcThreadAttributeList(attributes) };
    if started == 0 {
        return Err(format!("the program did not start ({failure})"));
    }
    let mut code = 1u32;
    // SAFETY: both handles came from the call above and are closed once each.
    unsafe {
        CloseHandle(process.hThread);
        WaitForSingleObject(process.hProcess, INFINITE);
        GetExitCodeProcess(process.hProcess, &mut code);
        CloseHandle(process.hProcess as HANDLE);
    }
    Ok(i32::from_ne_bytes(code.to_ne_bytes()))
}

/// Says which path a container could not be given.
fn refused(path: &str) -> impl Fn(String) -> String + '_ {
    move |reason| format!("{path} could not be opened to it ({reason})")
}

/// A container's identity and the capabilities it holds.
type Identities = (PSID, Vec<PSID>);

/// Opens a policy's folders: its own to its container, the shared ones to their capabilities, then closes what it
/// denies. The folders above each of them are opened as far as knowing they are there. Returns the identities a
/// program in the container runs with, and the shared folders and folders above that could not be opened, which only
/// an administrator can do for a folder that is not the person's own.
pub fn prepare(policy: &Policy) -> Result<(Identities, Vec<String>), String> {
    let container = container(&policy.name())?;
    if let Some(temporary) = &policy.temporary {
        let _ = std::fs::create_dir_all(temporary);
    }
    for path in &policy.write {
        open(path, container, MODIFY, false).map_err(refused(path))?;
    }
    for path in &policy.read {
        open(path, container, READ, false).map_err(refused(path))?;
    }
    let mut closed_to_it: Vec<String> = Vec::new();
    let mut capabilities = Vec::new();
    for shared in &policy.shared {
        let identity = capability(&shared.name)?;
        for (paths, rights) in [(&shared.write, MODIFY), (&shared.read, READ)] {
            for path in paths {
                // Windows's own folders and most of Program Files are open to every container already.
                if open(path, identity, rights, false).is_err() {
                    closed_to_it.push(path.clone());
                }
            }
        }
        capabilities.push(identity);
    }
    // The folders above, opened to whatever every one of these sandboxes holds, so the entry is made once.
    let passer = capabilities.first().copied().unwrap_or(container);
    let mut above: Vec<String> = Vec::new();
    let named = policy.write.iter().chain(&policy.read).chain(
        policy
            .shared
            .iter()
            .flat_map(|shared| shared.write.iter().chain(&shared.read)),
    );
    for path in named {
        for folder in Path::new(path).ancestors().skip(1) {
            let folder = folder.to_string_lossy().into_owned();
            if !folder.is_empty() && !above.contains(&folder) {
                above.push(folder);
            }
        }
    }
    for folder in above {
        if open(&folder, passer, ATTRIBUTES, true).is_err() {
            closed_to_it.push(folder);
        }
    }
    let mut every = vec![container];
    every.extend(&capabilities);
    for path in &policy.deny {
        close(path, &every)
            .map_err(|reason| format!("{path} could not be closed to it ({reason})"))?;
    }
    Ok(((container, capabilities), closed_to_it))
}

/// The launcher: reads the policy and the command from this program's command line, opens the policy's folders to its
/// container, and runs the command there.
pub fn launch() -> Result<i32, String> {
    let line = command_line();
    let (argument, rest) = split_command_line(&line).ok_or("it was given no policy and command")?;
    let policy = Policy::decoded(&argument).ok_or("its policy could not be read")?;
    let mut line: Vec<u16> = line[rest..].to_vec();
    if line.is_empty() {
        return Err("it was given no command".to_owned());
    }
    line.push(0);
    let (container, mut identities) = prepare(&policy)?.0;
    identities.insert(0, container);
    // A program that cannot load a library says so and ends, where it would otherwise wait at a message nobody sees.
    // SAFETY: changes how this process and the ones it starts report such errors, and nothing else.
    unsafe {
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX)
    };
    if let Some(temporary) = &policy.temporary {
        set_variable("TEMP", temporary);
        set_variable("TMP", temporary);
    }
    let mut network = Vec::new();
    if policy.network {
        for kind in [
            WinCapabilityInternetClientSid,
            WinCapabilityInternetClientServerSid,
            WinCapabilityPrivateNetworkClientServerSid,
        ] {
            network.push(well_known(kind)?);
        }
    }
    let mut capabilities: Vec<SID_AND_ATTRIBUTES> = identities[1..]
        .iter()
        .map(|identity| SID_AND_ATTRIBUTES {
            Sid: *identity,
            Attributes: ENABLED,
        })
        .collect();
    for identity in &mut network {
        capabilities.push(SID_AND_ATTRIBUTES {
            Sid: identity.as_mut_ptr().cast(),
            Attributes: ENABLED,
        });
    }
    end_together();
    run(&mut line, container, &mut capabilities)
}
