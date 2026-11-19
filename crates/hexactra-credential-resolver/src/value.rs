//! [`SecretValue`]: a value that cannot leak by accident.

use zeroize::Zeroize;

#[cfg(test)]
thread_local! {
    /// What each dropped value's buffer held right after the wipe (test
    /// builds only): proves the bytes are zero when the buffer is released.
    pub(crate) static DROPPED: std::cell::RefCell<Vec<Vec<u8>>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// A secret held in memory for one operation.
///
/// It has no `Debug`, no `Display`, no `Serialize`, and it is not `Clone`, so
/// it cannot be formatted into a log line, written into JSON or copied by
/// accident. The only way to read it is [`SecretValue::expose`], a closure
/// that sees the bytes. Its buffer is overwritten with zeros when it is
/// dropped, on success, failure, timeout and cancellation alike.
pub struct SecretValue {
    bytes: Vec<u8>,
}

impl SecretValue {
    /// Take ownership of `bytes` (no copy is made).
    pub fn new(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }

    /// Take ownership of a string's bytes (no copy is made).
    pub fn from_string(s: String) -> Self {
        Self::new(s.into_bytes())
    }

    /// Run `f` on the bytes. Whatever `f` returns must not hold them.
    pub fn expose<R>(&self, f: impl FnOnce(&[u8]) -> R) -> R {
        f(&self.bytes)
    }
}

impl Drop for SecretValue {
    fn drop(&mut self) {
        self.bytes.zeroize();
        #[cfg(test)]
        DROPPED.with(|d| {
            // `zeroize` on a `Vec` clears it to length 0 after wiping the
            // whole allocation, so record the wiped capacity instead.
            let cap = self.bytes.capacity();
            let wiped = unsafe { std::slice::from_raw_parts(self.bytes.as_ptr(), cap) };
            d.borrow_mut().push(wiped.to_vec());
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use static_assertions::assert_not_impl_any;

    // Compile-time proof: formatting, serialising and cloning do not exist.
    assert_not_impl_any!(SecretValue: Clone, Copy, std::fmt::Debug, std::fmt::Display, serde::Serialize, PartialEq, Default);

    #[test]
    fn exposes_bytes_only_through_the_closure() {
        let v = SecretValue::from_string("canary-value".into());
        assert_eq!(v.expose(|b| b.to_vec()), b"canary-value".to_vec());
        assert_eq!(v.expose(|b| b.len()), 12);
    }

    #[test]
    fn the_buffer_is_wiped_on_drop() {
        DROPPED.with(|d| d.borrow_mut().clear());
        let secret = b"canary-secret-bytes".to_vec();
        let v = SecretValue::new(secret.clone());
        assert!(v.expose(|b| b == secret.as_slice()));
        drop(v);
        DROPPED.with(|d| {
            let d = d.borrow();
            assert_eq!(d.len(), 1);
            assert!(d[0].len() >= secret.len());
            assert!(d[0].iter().all(|b| *b == 0), "buffer not wiped: {:?}", d[0]);
        });
    }

    #[test]
    fn the_buffer_is_wiped_when_a_task_is_cancelled() {
        DROPPED.with(|d| d.borrow_mut().clear());
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let v = SecretValue::from_string("cancelled-canary".into());
            let fut = async move {
                // Held across an await point, then dropped unfinished.
                tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                v.expose(|b| b.len())
            };
            let _ = tokio::time::timeout(std::time::Duration::from_millis(10), fut).await;
        });
        DROPPED.with(|d| {
            let d = d.borrow();
            assert_eq!(d.len(), 1);
            assert!(d[0].iter().all(|b| *b == 0));
        });
    }
}
