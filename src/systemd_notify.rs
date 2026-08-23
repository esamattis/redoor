//! Sends service readiness directly to systemd's notification socket.

use std::io;

/// Reports that the current process is ready when systemd provided a notification socket.
#[cfg(target_os = "linux")]
pub(crate) async fn ready() -> io::Result<()> {
    let Some(socket_name) = std::env::var_os("NOTIFY_SOCKET") else {
        return Ok(());
    };

    notify_ready_at(&socket_name).await
}

/// Keeps readiness calls portable for builds that cannot run under systemd.
#[cfg(not(target_os = "linux"))]
pub(crate) async fn ready() -> io::Result<()> {
    Ok(())
}

/// Sends the readiness datagram to a filesystem or Linux abstract Unix socket.
#[cfg(target_os = "linux")]
async fn notify_ready_at(socket_name: &std::ffi::OsStr) -> io::Result<()> {
    use std::os::{linux::net::SocketAddrExt, unix::ffi::OsStrExt};

    let bytes = socket_name.as_bytes();
    let address = match bytes.first() {
        Some(b'@') => std::os::unix::net::SocketAddr::from_abstract_name(&bytes[1..])?,
        Some(_) => {
            std::os::unix::net::SocketAddr::from_pathname(std::path::Path::new(socket_name))?
        }
        None => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "NOTIFY_SOCKET is empty",
            ));
        }
    };

    let socket = std::os::unix::net::UnixDatagram::unbound()?;
    socket.connect_addr(&address)?;
    socket.set_nonblocking(true)?;
    let socket = tokio::net::UnixDatagram::from_std(socket)?;
    let message = b"READY=1";
    let sent = socket.send(message).await?;
    if sent != message.len() {
        return Err(io::Error::new(
            io::ErrorKind::WriteZero,
            "systemd readiness datagram was truncated",
        ));
    }

    Ok(())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::notify_ready_at;
    use std::os::linux::net::SocketAddrExt;

    /// Verifies readiness reaches the filesystem sockets used by some systemd configurations.
    #[tokio::test]
    async fn sends_ready_to_filesystem_socket() {
        let directory = crate::test_support::TempDir::create();
        let path = directory.path().join("notify.sock");
        let receiver = tokio::net::UnixDatagram::bind(&path).unwrap();

        notify_ready_at(path.as_os_str()).await.unwrap();

        let mut message = [0_u8; 32];
        let received = receiver.recv(&mut message).await.unwrap();
        assert_eq!(
            &message[..received],
            b"READY=1",
            "systemd must receive the exact readiness assignment"
        );
    }

    /// Verifies the leading-at syntax reaches systemd's usual abstract notification socket.
    #[tokio::test]
    async fn sends_ready_to_abstract_socket() {
        let name = format!("redoor-notify-{}", uuid::Uuid::new_v4().simple());
        let address = std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes()).unwrap();
        let receiver = std::os::unix::net::UnixDatagram::bind_addr(&address).unwrap();
        receiver.set_nonblocking(true).unwrap();
        let receiver = tokio::net::UnixDatagram::from_std(receiver).unwrap();
        let notify_socket = format!("@{name}");

        notify_ready_at(notify_socket.as_ref()).await.unwrap();

        let mut message = [0_u8; 32];
        let received = receiver.recv(&mut message).await.unwrap();
        assert_eq!(
            &message[..received],
            b"READY=1",
            "abstract sockets must receive the same readiness assignment"
        );
    }
}
