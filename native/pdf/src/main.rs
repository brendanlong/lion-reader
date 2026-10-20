//! `lion-reader-pdf`: reads one PDF on stdin, writes the converted article as
//! JSON on stdout. Spawned by `src/server/file/pdf-to-markdown.ts`.
//!
//! A separate process rather than an N-API module because a hostile PDF can
//! drive pdf_oxide to gigabytes of memory or minutes of CPU on a single page (a
//! 300KB decompression bomb reached 940MB; 7MB of text operators, 2.6GB), and
//! nothing inside a process can bound that. Here the kernel does: the process
//! caps its own heap and CPU time before reading any input, and the parent
//! kills it at a wall-clock deadline. Hitting a cap kills only this process.
//!
//! Usage: lion-reader-pdf <max-memory-bytes> <max-cpu-seconds> <max-pages> <max-output-bytes>
//!
//! Output is `{"markdown", "title", "author", "summary"}` on success or
//! `{"error": <code>}` for a document we can't convert; any other exit means
//! the process died (a resource cap, or a pdf_oxide panic).

use std::io::{Read, Write};
use std::process::ExitCode;

use lion_reader_pdf::{convert, Limits};
use serde_json::json;

fn main() -> ExitCode {
    let args: Vec<u64> = std::env::args()
        .skip(1)
        .map(|arg| arg.parse::<u64>())
        .collect::<Result<_, _>>()
        .unwrap_or_default();
    let [max_memory_bytes, max_cpu_seconds, max_pages, max_output_bytes] = args[..] else {
        eprintln!("usage: lion-reader-pdf <max-memory-bytes> <max-cpu-seconds> <max-pages> <max-output-bytes>");
        return ExitCode::from(64);
    };

    // RLIMIT_DATA covers the heap (brk and anonymous mmap), which is where a
    // runaway parse grows, without counting the binary or the stack the way
    // RLIMIT_AS would. Allocation failure aborts the process. No core dumps:
    // each capped conversion would otherwise write one the size of its heap.
    if let Err(error) = set_limit(libc::RLIMIT_DATA, max_memory_bytes)
        .and_then(|()| set_limit(libc::RLIMIT_CPU, max_cpu_seconds))
        .and_then(|()| set_limit(libc::RLIMIT_CORE, 0))
    {
        eprintln!("setrlimit failed: {error}");
        return ExitCode::from(71);
    }

    let mut bytes = Vec::new();
    if let Err(error) = std::io::stdin().read_to_end(&mut bytes) {
        eprintln!("reading stdin failed: {error}");
        return ExitCode::from(74);
    }

    let limits = Limits {
        max_pages: max_pages as usize,
        max_output_bytes: max_output_bytes as usize,
    };
    let output = match convert(bytes, &limits) {
        Ok(converted) => json!({
            "markdown": converted.markdown,
            "title": converted.title,
            "author": converted.author,
            "summary": converted.summary,
        }),
        Err(error) => json!({ "error": error.code() }),
    };

    let mut stdout = std::io::stdout().lock();
    if serde_json::to_writer(&mut stdout, &output)
        .map_err(std::io::Error::from)
        .and_then(|()| stdout.flush())
        .is_err()
    {
        return ExitCode::from(74);
    }
    ExitCode::SUCCESS
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
type Resource = libc::__rlimit_resource_t;
#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
type Resource = libc::c_int;

/// Lowers both limits to `value`, or to the inherited hard limit if that is
/// already lower (raising it would fail).
fn set_limit(resource: Resource, value: u64) -> std::io::Result<()> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: getrlimit writes only to the struct we pass.
    if unsafe { libc::getrlimit(resource, &mut limit) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let value = (value as libc::rlim_t).min(limit.rlim_max);
    limit.rlim_cur = value;
    limit.rlim_max = value;
    // SAFETY: setrlimit only reads the struct we pass.
    if unsafe { libc::setrlimit(resource, &limit) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}
