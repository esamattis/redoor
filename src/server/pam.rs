//! Verifies the OS password of the process owner via Linux PAM.
//!
//! Used when `[server]` omits `username`/`password` so local operators can log
//! in with their existing system account instead of a second shared secret.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;

use anyhow::{Context, Result, bail};
use nix::unistd::{User, getuid};
use redoor::{Level, log};

// --- PAM FFI bindings (no external crate) ---

#[repr(C)]
struct PamHandle {
    _private: [u8; 0],
}

#[repr(C)]
struct PamMessage {
    msg_style: c_int,
    msg: *const c_char,
}

#[repr(C)]
struct PamResponse {
    resp: *mut c_char,
    resp_retcode: c_int,
}

#[repr(C)]
struct PamConv {
    conv: Option<
        unsafe extern "C" fn(
            num_msg: c_int,
            msg: *mut *const PamMessage,
            resp: *mut *mut PamResponse,
            appdata_ptr: *mut c_void,
        ) -> c_int,
    >,
    appdata_ptr: *mut c_void,
}

const PAM_SUCCESS: c_int = 0;
const PAM_AUTH_ERR: c_int = 7;
/// Password prompt; PAM frees our strdup'd response after authentication.
const PAM_PROMPT_ECHO_OFF: c_int = 1;

// Linked via build.rs (`-lpam` or `-l:libpam.so.0`) so systems without
// libpam-dev still compile against the runtime soname.
unsafe extern "C" {
    fn pam_start(
        service_name: *const c_char,
        user: *const c_char,
        pam_conversation: *const PamConv,
        pamh: *mut *mut PamHandle,
    ) -> c_int;

    fn pam_authenticate(pamh: *mut PamHandle, flags: c_int) -> c_int;

    fn pam_end(pamh: *mut PamHandle, pam_status: c_int) -> c_int;

    fn pam_strerror(pamh: *mut PamHandle, errnum: c_int) -> *const c_char;
}

/// Conversation callback that answers password prompts with the candidate we hold in appdata.
unsafe extern "C" fn conversation(
    num_msg: c_int,
    msg: *mut *const PamMessage,
    resp: *mut *mut PamResponse,
    appdata_ptr: *mut c_void,
) -> c_int {
    unsafe {
        if num_msg <= 0 || msg.is_null() || resp.is_null() {
            log!(
                Level::Error,
                "PAM conversation rejected: num_msg={num_msg}, msg_null={}, resp_null={}",
                msg.is_null(),
                resp.is_null()
            );
            return PAM_AUTH_ERR;
        }

        // appdata_ptr holds a pointer to our password CString bytes.
        let password_ptr = appdata_ptr as *const c_char;
        if password_ptr.is_null() {
            log!(
                Level::Error,
                "PAM conversation rejected: password appdata pointer is null"
            );
            return PAM_AUTH_ERR;
        }

        // PAM expects malloc-compatible allocation so it can free the responses itself.
        let responses = libc::malloc((num_msg as usize) * std::mem::size_of::<PamResponse>())
            as *mut PamResponse;

        if responses.is_null() {
            log!(
                Level::Error,
                "PAM conversation rejected: failed to allocate {} response slots",
                num_msg
            );
            return PAM_AUTH_ERR;
        }

        for i in 0..num_msg {
            let m = *msg.add(i as usize);
            let style = (*m).msg_style;

            let r = responses.add(i as usize);
            (*r).resp_retcode = 0;

            if style == PAM_PROMPT_ECHO_OFF {
                // Give PAM a copy of the password; PAM takes ownership of this buffer.
                (*r).resp = libc::strdup(password_ptr);
                if (*r).resp.is_null() {
                    log!(
                        Level::Error,
                        "PAM conversation rejected: strdup failed for password response index {i}"
                    );
                    // Free any earlier responses before aborting so we do not leak.
                    for j in 0..=i {
                        let prev = responses.add(j as usize);
                        if !(*prev).resp.is_null() {
                            libc::free((*prev).resp as *mut c_void);
                        }
                    }
                    libc::free(responses as *mut c_void);
                    return PAM_AUTH_ERR;
                }
            } else {
                (*r).resp = ptr::null_mut();
            }
        }

        *resp = responses;
        PAM_SUCCESS
    }
}

/// Translates a PAM status code into a human-readable message when possible.
fn pam_error_message(pamh: *mut PamHandle, status: c_int) -> String {
    if pamh.is_null() {
        return format!("pam status {status} (no handle for strerror)");
    }
    let ptr = unsafe { pam_strerror(pamh, status) };
    if ptr.is_null() {
        return format!("pam status {status} (strerror returned null)");
    }
    match unsafe { CStr::from_ptr(ptr) }.to_str() {
        Ok(message) => format!("pam status {status}: {message}"),
        Err(error) => format!("pam status {status} (strerror not utf-8: {error})"),
    }
}

/// Returns `true` if the password is correct for the *current* process user.
///
/// Blocking: call only from `spawn_blocking` so the async runtime stays responsive.
pub fn verify_current_user_password(password: &str) -> Result<bool> {
    // 1. Resolve the effective UID to a username PAM understands.
    let uid = getuid();
    let user = User::from_uid(uid)
        .with_context(|| format!("failed to look up system user for uid {uid}"))?
        .with_context(|| format!("no system user entry exists for process uid {uid}"))?;
    let username = CString::new(user.name.as_str()).with_context(|| {
        format!(
            "process username {:?} contains an interior NUL byte",
            user.name
        )
    })?;

    log!(
        Level::Debug,
        "PAM authentication starting: uid={uid}, username={}",
        user.name
    );

    // 2. Prepare password as C string (passed via appdata into the conversation).
    let password_c = CString::new(password)
        .context("login password contains an interior NUL byte and cannot be passed to PAM")?;

    // 3. Set up conversation.
    let conv = PamConv {
        conv: Some(conversation),
        appdata_ptr: password_c.as_ptr() as *mut c_void,
    };

    // 4. Start PAM transaction. "login" is the conventional local interactive service.
    let service = CString::new("login").context("PAM service name is invalid")?;
    let mut pamh: *mut PamHandle = ptr::null_mut();

    let mut status = unsafe { pam_start(service.as_ptr(), username.as_ptr(), &conv, &mut pamh) };

    if status != PAM_SUCCESS {
        let message = pam_error_message(pamh, status);
        log!(
            Level::Error,
            "pam_start failed for user {}: {message}",
            user.name
        );
        if !pamh.is_null() {
            unsafe {
                pam_end(pamh, status);
            }
        }
        bail!("pam_start failed for user {}: {message}", user.name);
    }

    // 5. Authenticate.
    status = unsafe { pam_authenticate(pamh, 0) };
    let authenticated = status == PAM_SUCCESS;
    if authenticated {
        log!(
            Level::Debug,
            "PAM authentication succeeded for user {}",
            user.name
        );
    } else {
        let message = pam_error_message(pamh, status);
        // Wrong passwords are expected; keep detail in logs without treating as a hard failure.
        log!(
            Level::Info,
            "PAM authentication rejected for user {}: {message}",
            user.name
        );
    }

    // 6. Clean up regardless of success so PAM resources are not leaked.
    let end_status = unsafe { pam_end(pamh, status) };
    if end_status != PAM_SUCCESS {
        // pamh is invalid after pam_end; report the numeric code only.
        log!(
            Level::Error,
            "pam_end failed after authenticate for user {}: status={end_status}",
            user.name
        );
        bail!(
            "pam_end failed after authenticate for user {}: status={end_status}",
            user.name
        );
    }

    Ok(authenticated)
}
