//! Verifies the OS password of the process owner via Linux PAM.
//!
//! Used when `[server]` omits `username`/`password` so local operators can log
//! in with their existing system account instead of a second shared secret.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;

use std::sync::Arc;

use anyhow::{Context, Result, bail};
use libloading::Library;
use nix::unistd::{User, getuid};
use redoor::{Level, log};

/// Opaque transaction handle owned and initialized by PAM.
#[repr(C)]
struct PamHandle {
    _private: [u8; 0],
}

/// Describes one prompt from a PAM module to the application conversation callback.
#[repr(C)]
struct PamMessage {
    msg_style: c_int,
    msg: *const c_char,
}

/// Returns one malloc-owned response that PAM can release after the conversation.
#[repr(C)]
struct PamResponse {
    resp: *mut c_char,
    resp_retcode: c_int,
}

/// Connects a PAM transaction to the callback carrying the candidate password.
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

/// ABI signature for starting a PAM transaction.
type PamStart = unsafe extern "C" fn(
    service_name: *const c_char,
    user: *const c_char,
    pam_conversation: *const PamConv,
    pamh: *mut *mut PamHandle,
) -> c_int;
/// ABI signature for verifying the transaction's authentication token.
type PamAuthenticate = unsafe extern "C" fn(pamh: *mut PamHandle, flags: c_int) -> c_int;
/// ABI signature for enforcing account policy after the authentication token is accepted.
type PamAcctMgmt = unsafe extern "C" fn(pamh: *mut PamHandle, flags: c_int) -> c_int;
/// ABI signature for ending a PAM transaction and releasing its resources.
type PamEnd = unsafe extern "C" fn(pamh: *mut PamHandle, pam_status: c_int) -> c_int;
/// ABI signature for obtaining a PAM-owned description of a status code.
type PamStrerror = unsafe extern "C" fn(pamh: *mut PamHandle, errnum: c_int) -> *const c_char;

const PAM_SUCCESS: c_int = 0;
const PAM_AUTH_ERR: c_int = 7;
/// Password prompt; PAM frees our strdup'd response after authentication.
const PAM_PROMPT_ECHO_OFF: c_int = 1;

/// Shares a validated PAM runtime across blocking login tasks without exposing borrowed symbols.
#[derive(Clone)]
pub(crate) struct PamApi(Arc<PamApiInner>);

/// Owns copied function pointers together with the library that keeps their code mapped.
struct PamApiInner {
    pam_start: PamStart,
    pam_authenticate: PamAuthenticate,
    pam_acct_mgmt: PamAcctMgmt,
    pam_end: PamEnd,
    pam_strerror: PamStrerror,
    // This handle must outlive every copied function pointer above.
    _library: Library,
}

impl PamApi {
    /// Loads PAM only for system-user authentication so configured credentials need no PAM runtime.
    pub(crate) fn load() -> Result<Self> {
        Self::load_library().with_context(|| {
            "Linux PAM authentication requires libpam.so.0 and its standard symbols; install the PAM runtime package (for example libpam0g on Debian/Ubuntu or pam on Fedora/RHEL/Arch), or set both server.username and server.password"
        })
    }

    /// Resolves all required symbols and copies their pointers before storing the owned library.
    fn load_library() -> Result<Self> {
        // Loading arbitrary shared libraries is unsafe; the fixed PAM soname and signatures below
        // are the stable Linux PAM ABI expected by this module.
        let library =
            unsafe { Library::new("libpam.so.0") }.context("failed to load libpam.so.0")?;
        let pam_start = unsafe { load_symbol(&library, b"pam_start\0", "pam_start") }
            .context("failed to resolve required PAM function pam_start from libpam.so.0")?;
        let pam_authenticate =
            unsafe { load_symbol(&library, b"pam_authenticate\0", "pam_authenticate") }.context(
                "failed to resolve required PAM function pam_authenticate from libpam.so.0",
            )?;
        let pam_acct_mgmt = unsafe { load_symbol(&library, b"pam_acct_mgmt\0", "pam_acct_mgmt") }
            .context(
            "failed to resolve required PAM function pam_acct_mgmt from libpam.so.0",
        )?;
        let pam_end = unsafe { load_symbol(&library, b"pam_end\0", "pam_end") }
            .context("failed to resolve required PAM function pam_end from libpam.so.0")?;
        let pam_strerror = unsafe { load_symbol(&library, b"pam_strerror\0", "pam_strerror") }
            .context("failed to resolve required PAM function pam_strerror from libpam.so.0")?;

        Ok(Self(Arc::new(PamApiInner {
            pam_start,
            pam_authenticate,
            pam_acct_mgmt,
            pam_end,
            pam_strerror,
            _library: library,
        })))
    }
}

/// Copies one resolved pointer so no `Symbol` borrowing the library escapes this call.
///
/// The caller must provide the exact ABI signature exported under `symbol`.
unsafe fn load_symbol<T: Copy>(library: &Library, symbol: &[u8], symbol_name: &str) -> Result<T> {
    let symbol = unsafe { library.get::<T>(symbol) }
        .with_context(|| format!("libpam.so.0 is missing required symbol {symbol_name}"))?;
    Ok(*symbol)
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
fn pam_error_message(api: &PamApi, pamh: *mut PamHandle, status: c_int) -> String {
    if pamh.is_null() {
        return format!("pam status {status} (no handle for strerror)");
    }
    let ptr = unsafe { (api.0.pam_strerror)(pamh, status) };
    if ptr.is_null() {
        return format!("pam status {status} (strerror returned null)");
    }
    match unsafe { CStr::from_ptr(ptr) }.to_str() {
        Ok(message) => format!("pam status {status}: {message}"),
        Err(error) => format!("pam status {status} (strerror not utf-8: {error})"),
    }
}

impl PamApi {
    /// Returns `true` when PAM authenticates the password and authorizes the process user.
    ///
    /// Blocking: call only from `spawn_blocking` so the async runtime stays responsive.
    pub(crate) fn verify_current_user_password(&self, password: &str) -> Result<bool> {
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
            "PAM login verification starting: uid={uid}, username={}",
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

        let mut status =
            unsafe { (self.0.pam_start)(service.as_ptr(), username.as_ptr(), &conv, &mut pamh) };

        if status != PAM_SUCCESS {
            let message = pam_error_message(self, pamh, status);
            log!(
                Level::Error,
                "pam_start failed for user {}: {message}",
                user.name
            );
            if !pamh.is_null() {
                unsafe {
                    (self.0.pam_end)(pamh, status);
                }
            }
            bail!("pam_start failed for user {}: {message}", user.name);
        }

        // 5. Authenticate the password before asking PAM whether the account may log in.
        status = unsafe { (self.0.pam_authenticate)(pamh, 0) };
        let accepted = if status == PAM_SUCCESS {
            log!(
                Level::Debug,
                "PAM authentication succeeded for user {}; checking account authorization",
                user.name
            );

            // Account management runs the service's configured PAM account stack, which may
            // reject expired or disabled accounts, expired passwords requiring renewal,
            // disallowed login times or origins, `pam_nologin`, and administrator-defined
            // access rules. Password authentication alone intentionally skips these policies.
            status = unsafe { (self.0.pam_acct_mgmt)(pamh, 0) };
            if status == PAM_SUCCESS {
                log!(
                    Level::Debug,
                    "PAM authentication and account authorization succeeded for user {}",
                    user.name
                );
                true
            } else {
                let message = pam_error_message(self, pamh, status);
                // Policy denials are normal rejected logins; details stay in internal logs.
                log!(
                    Level::Info,
                    "PAM account authorization rejected for user {}: {message}",
                    user.name
                );
                false
            }
        } else {
            let message = pam_error_message(self, pamh, status);
            // Wrong passwords are expected; keep detail in logs without treating as a hard failure.
            log!(
                Level::Info,
                "PAM authentication rejected for user {}: {message}",
                user.name
            );
            false
        };

        // 6. Pass the final phase status to PAM so modules can clean up consistently.
        let end_status = unsafe { (self.0.pam_end)(pamh, status) };
        if end_status != PAM_SUCCESS {
            // pamh is invalid after pam_end; report the numeric code only.
            log!(
                Level::Error,
                "pam_end failed after login verification for user {}: status={end_status}",
                user.name
            );
            bail!(
                "pam_end failed after login verification for user {}: status={end_status}",
                user.name
            );
        }

        Ok(accepted)
    }
}
