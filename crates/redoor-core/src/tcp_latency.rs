//! TCP socket options that keep control frames responsive while bulk transfers share the
//! connection.
//!
//! The agent and server writers put control frames ahead of data frames, but that order only
//! covers frames not yet handed to the socket. Whatever already sits in the kernel's send
//! buffer, which Linux autotunes up to megabytes, goes out first, so a control frame written
//! during a transfer could wait seconds behind it on a slow link. These options keep that
//! backlog small without limiting throughput.

use std::io;
#[cfg(any(target_os = "linux", target_os = "android"))]
use std::os::fd::AsRawFd;

use redoor_protocol::wire::log::Level;
use tokio::net::TcpStream;

use crate::log;

/// Most unsent bytes the kernel queues before it reports the socket unwritable.
///
/// Half a data frame: enough to keep the link busy between writer wakeups, small enough that a
/// control frame queues behind well under one frame of kernel backlog. Unacknowledged bytes in
/// flight are not counted, so this does not cap throughput on long, fast links.
pub const UNSENT_LOW_WATER_BYTES: u32 = 32 * 1024;

/// Tunes a connection that carries both control messages and bulk data.
///
/// `TCP_NODELAY` stops Nagle's algorithm from holding a small control frame until earlier data
/// is acknowledged. `TCP_NOTSENT_LOWAT` keeps the kernel's unsent backlog small, so queued data
/// waits in the writers' priority lanes instead. A failure only costs latency, never
/// correctness, so it is logged and the connection is used as is.
pub fn tune_for_latency(stream: &TcpStream) {
    if let Err(error) = stream.set_nodelay(true) {
        log!(Level::Debug, "Failed to set TCP_NODELAY: {error}");
    }
    if let Err(error) = set_unsent_low_water(stream, UNSENT_LOW_WATER_BYTES) {
        log!(Level::Debug, "Failed to set TCP_NOTSENT_LOWAT: {error}");
    }
}

/// Sets `TCP_NOTSENT_LOWAT` with `setsockopt`, which avoids a `socket2` dependency for one
/// option.
///
/// Only Linux and Android: their `send` refuses data beyond the mark. macOS uses the mark only
/// to decide when to report the socket writable, and Tokio keeps writing until `send` fails, so
/// the buffer would fill anyway.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn set_unsent_low_water(stream: &TcpStream, bytes: u32) -> io::Result<()> {
    let value = libc::c_int::try_from(bytes).map_err(io::Error::other)?;
    // SAFETY: the descriptor belongs to the borrowed live stream, the option value points to a
    // c_int on the stack whose exact size is passed, and setsockopt keeps no pointer.
    let result = unsafe {
        libc::setsockopt(
            stream.as_raw_fd(),
            libc::IPPROTO_TCP,
            libc::TCP_NOTSENT_LOWAT,
            std::ptr::from_ref(&value).cast(),
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Other platforms, macOS included, keep the kernel's default backlog and get only
/// `TCP_NODELAY`.
#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn set_unsent_low_water(_stream: &TcpStream, _bytes: u32) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    /// Reads `TCP_NOTSENT_LOWAT` back so the test sees what the kernel actually applied.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    fn unsent_low_water(stream: &TcpStream) -> u32 {
        let mut value: libc::c_int = 0;
        let mut length = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
        // SAFETY: both out pointers reference live stack values and `length` holds their size.
        let result = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::IPPROTO_TCP,
                libc::TCP_NOTSENT_LOWAT,
                std::ptr::from_mut(&mut value).cast(),
                &mut length,
            )
        };
        assert_eq!(result, 0, "reading TCP_NOTSENT_LOWAT should succeed");
        u32::try_from(value).expect("the low-water mark should be non-negative")
    }

    #[tokio::test]
    async fn tuning_sets_both_options_on_both_ends() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (client, accepted) = tokio::join!(TcpStream::connect(address), listener.accept());
        let client = client.unwrap();
        let (server, _) = accepted.unwrap();

        for stream in [&client, &server] {
            tune_for_latency(stream);
            // Without NODELAY a small control frame can wait for the ACK of earlier data.
            assert!(stream.nodelay().unwrap(), "TCP_NODELAY should be on");
            // The low-water mark is what keeps the kernel backlog in front of control frames
            // small, so it must be the value the kernel actually holds.
            #[cfg(any(target_os = "linux", target_os = "android"))]
            assert_eq!(unsent_low_water(stream), UNSENT_LOW_WATER_BYTES);
        }
    }
}
