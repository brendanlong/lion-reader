//! Zero-copy external strings across the N-API boundary (issue #1291).
//!
//! Converting parsed feed strings to JS normally copies every byte into the
//! V8 heap via `napi_create_string_utf8`, on the main thread for async
//! parses (`AsyncTask::resolve`). For multi-MB content bodies that copy is
//! the dominant cost of the whole parse. `node_api_create_external_string_latin1`
//! (Node 20.4+) instead lets V8 wrap Rust-owned memory directly; V8 frees it
//! through a finalizer when the string is collected.
//!
//! Constraints that shape this module:
//!
//! - External strings exist only in Latin-1 and UTF-16 flavors. Our data is
//!   UTF-8, but pure-ASCII UTF-8 *is* valid Latin-1, and feed content bodies
//!   (HTML markup + mostly-English text) are very often pure ASCII — so we
//!   take the zero-copy path only for ASCII strings and fall back to the
//!   ordinary copy otherwise. (A UTF-16 external arm would still be one full
//!   transcode-copy plus 2x resident memory for mostly-ASCII text, since V8
//!   couldn't use its one-byte representation — measured as not worth it.)
//! - Only strings at or above [`EXTERNAL_MIN_BYTES`] use the external path:
//!   each external string costs a GC-tracked finalizer, which beats a copy
//!   only when the copy is big.
//! - The ASCII scan is done at construction ([`LargeString::from`]), which
//!   for async parses runs inside `Task::compute` on the libuv pool — the
//!   main thread never pays for it.
//! - napi-rs 2 doesn't wrap these functions and our module targets napi8, so
//!   the symbol is resolved at runtime with `dlsym` and absence (Node < 20.4,
//!   non-unix) falls back to the copy. V8 may also *decline* the external
//!   string and copy anyway (the `copied` out-parameter, e.g. sandbox-enabled
//!   builds); the finalizer has then already run, per the API contract.
//!
//! Lifetime/safety invariant: the Rust `String` passed to
//! `create_external_latin1` is boxed and leaked before the call; exactly one
//! of the following frees it — the N-API finalizer (called at GC time, or
//! synchronously when V8 copies), or the explicit drop on a non-ok status.

use std::ffi::{c_char, c_void};
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};

use napi::bindgen_prelude::{FromNapiValue, ToNapiValue, TypeName, ValidateNapiValue};
use napi::{sys, Error, Result, Status, ValueType};

/// Minimum size for the external-string path. Below this a plain copy is
/// cheaper than a GC finalizer registration.
pub const EXTERNAL_MIN_BYTES: usize = 16 * 1024;

/// `node_api_create_external_string_latin1`, Node 20.4+. Signature per
/// `node_api.h`; `finalize_callback` receives (env, str, finalize_hint).
type CreateExternalStringLatin1 = unsafe extern "C" fn(
    env: sys::napi_env,
    str_: *mut c_char,
    length: usize,
    finalize_callback: sys::napi_finalize,
    finalize_hint: *mut c_void,
    result: *mut sys::napi_value,
    copied: *mut bool,
) -> sys::napi_status;

/// Conversion-path counters, exposed to JS via `stringConversionStats` so
/// benchmarks can see what actually happened (V8 is allowed to decline the
/// external string and copy anyway).
pub static EXTERNAL_CREATED: AtomicU64 = AtomicU64::new(0);
pub static EXTERNAL_DECLINED_COPIED: AtomicU64 = AtomicU64::new(0);
pub static COPIED_NON_ASCII: AtomicU64 = AtomicU64::new(0);
pub static COPIED_SMALL: AtomicU64 = AtomicU64::new(0);
pub static COPIED_NO_API: AtomicU64 = AtomicU64::new(0);

/// Resolves the external-string symbol from the host process once. `None`
/// when the running Node predates 20.4 (or on non-unix platforms, where we
/// have no dlsym; we only deploy on Linux).
fn external_latin1_fn() -> Option<CreateExternalStringLatin1> {
    static CELL: std::sync::OnceLock<Option<CreateExternalStringLatin1>> =
        std::sync::OnceLock::new();
    *CELL.get_or_init(|| {
        #[cfg(unix)]
        unsafe {
            let symbol = libc::dlsym(
                libc::RTLD_DEFAULT,
                c"node_api_create_external_string_latin1".as_ptr(),
            );
            if symbol.is_null() {
                None
            } else {
                Some(std::mem::transmute::<*mut c_void, CreateExternalStringLatin1>(symbol))
            }
        }
        #[cfg(not(unix))]
        {
            None
        }
    })
}

/// N-API finalizer for an external string: reclaims the boxed Rust `String`
/// leaked in `create_external_latin1`. Runs on the main thread at GC time
/// (or synchronously, when V8 copied instead of externalizing).
unsafe extern "C" fn finalize_external_string(
    _env: sys::napi_env,
    _finalize_data: *mut c_void,
    finalize_hint: *mut c_void,
) {
    drop(Box::from_raw(finalize_hint as *mut String));
}

fn check_status(status: sys::napi_status, what: &str) -> Result<()> {
    if status == sys::Status::napi_ok {
        Ok(())
    } else {
        Err(Error::new(
            Status::from(status),
            format!("{what} failed with status {status}"),
        ))
    }
}

/// Plain `napi_create_string_utf8` copy — the fallback for every case the
/// external path doesn't cover.
unsafe fn create_string_copy(env: sys::napi_env, value: &str) -> Result<sys::napi_value> {
    let mut result = ptr::null_mut();
    check_status(
        sys::napi_create_string_utf8(env, value.as_ptr() as *const c_char, value.len(), &mut result),
        "napi_create_string_utf8",
    )?;
    Ok(result)
}

/// Wraps `value` (which must be pure ASCII) as an external Latin-1 string.
/// Ownership of the allocation passes to the finalizer on success; on a
/// non-ok status we free it here and let the caller fall back to a copy.
unsafe fn create_external_latin1(
    create: CreateExternalStringLatin1,
    env: sys::napi_env,
    value: String,
) -> Result<sys::napi_value> {
    debug_assert!(value.is_ascii());
    let boxed = Box::new(value);
    let data = boxed.as_ptr() as *mut c_char;
    let length = boxed.len();
    let hint = Box::into_raw(boxed);
    let mut result = ptr::null_mut();
    let mut copied = false;
    let status = create(
        env,
        data,
        length,
        Some(finalize_external_string),
        hint as *mut c_void,
        &mut result,
        &mut copied,
    );
    if status != sys::Status::napi_ok {
        // The finalizer is not invoked on failure; reclaim the allocation.
        drop(Box::from_raw(hint));
        return Err(Error::new(
            Status::from(status),
            format!("node_api_create_external_string_latin1 failed with status {status}"),
        ));
    }
    // On success the allocation belongs to the finalizer — including the
    // copied=true case, where the API contract says it has already run.
    if copied {
        EXTERNAL_DECLINED_COPIED.fetch_add(1, Ordering::Relaxed);
    } else {
        EXTERNAL_CREATED.fetch_add(1, Ordering::Relaxed);
    }
    Ok(result)
}

/// A parsed-feed string field that may be large (content/summary bodies).
/// Converts to JS as a zero-copy external string when profitable; otherwise
/// exactly like a plain `String`. Construct via `From<String>` — that's where
/// the ASCII scan happens (off the main thread for async parses).
pub struct LargeString {
    value: String,
    /// Eligible for the external path: at/above the size threshold AND pure
    /// ASCII (so the UTF-8 bytes are valid Latin-1 as-is).
    external_eligible: bool,
}

impl From<String> for LargeString {
    fn from(value: String) -> Self {
        let external_eligible = value.len() >= EXTERNAL_MIN_BYTES && value.is_ascii();
        Self {
            value,
            external_eligible,
        }
    }
}

impl TypeName for LargeString {
    fn type_name() -> &'static str {
        "string"
    }

    fn value_type() -> ValueType {
        ValueType::String
    }
}

impl ValidateNapiValue for LargeString {}

impl ToNapiValue for LargeString {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        if val.external_eligible {
            if let Some(create) = external_latin1_fn() {
                // On a non-ok status the string has already been freed, so
                // there is no copy fallback from here; surface the error
                // (never observed in practice — napi_ok covers the V8
                // "declined and copied" case via the `copied` out-param).
                return create_external_latin1(create, env, val.value);
            }
            COPIED_NO_API.fetch_add(1, Ordering::Relaxed);
        } else if val.value.len() >= EXTERNAL_MIN_BYTES {
            COPIED_NON_ASCII.fetch_add(1, Ordering::Relaxed);
        } else {
            COPIED_SMALL.fetch_add(1, Ordering::Relaxed);
        }
        create_string_copy(env, &val.value)
    }
}

/// Only used if JS ever passes one of these objects back in (it doesn't
/// today); required because `#[napi(object)]` derives both directions.
impl FromNapiValue for LargeString {
    unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
        Ok(String::from_napi_value(env, value)?.into())
    }
}
