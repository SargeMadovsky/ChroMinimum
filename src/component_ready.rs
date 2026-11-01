//! Bounded startup message; a closed launcher pipe must never panic the browser.
use std::io::{self, Write};

pub fn send(mut output: impl Write, id: &str, nonce: &str) -> io::Result<()> {
    writeln!(output, "component-ready {id} {nonce}")?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn message_matches_launcher_protocol() {
        let mut output = Vec::new();
        send(&mut output, "installed-id", "launch-nonce").unwrap();
        assert_eq!(output, b"component-ready installed-id launch-nonce\n");
    }
    #[test]
    fn closed_pipe_is_an_error_not_a_panic() {
        struct Closed;
        impl Write for Closed {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        assert_eq!(
            send(Closed, "id", "nonce").unwrap_err().kind(),
            io::ErrorKind::BrokenPipe
        );
    }
}
