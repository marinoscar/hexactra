//! Whether this machine has a Bluetooth adapter (#924).
//!
//! Chrome's "use a phone or tablet" passkey QR code (the hybrid transport)
//! needs the phone to reach the computer that shows the code over Bluetooth.
//! The host reports what it has, so the console can tell the agent not to ask
//! the owner to scan a code that cannot work on this machine.

use std::path::Path;

/// `Some(true)` when the kernel lists a Bluetooth adapter, `Some(false)` when
/// it lists none, `None` where this cannot be told (not Linux, no sysfs).
pub fn present() -> Option<bool> {
    if cfg!(target_os = "linux") {
        adapters_in(Path::new("/sys/class"))
    } else {
        None
    }
}

/// Whether `<sysfs>/bluetooth` holds an adapter (`hci0`, `hci1`, ...).
fn adapters_in(sysfs_class: &Path) -> Option<bool> {
    if !sysfs_class.is_dir() {
        return None;
    }
    let dir = sysfs_class.join("bluetooth");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        // The class exists only once the bluetooth module is loaded: no
        // directory on a machine with sysfs means no adapter.
        return Some(false);
    };
    Some(
        entries
            .flatten()
            .any(|e| e.file_name().to_string_lossy().starts_with("hci")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_adapter_is_found_by_its_hci_entry() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(adapters_in(root.path()), Some(false));
        std::fs::create_dir_all(root.path().join("bluetooth")).unwrap();
        assert_eq!(adapters_in(root.path()), Some(false));
        std::fs::create_dir_all(root.path().join("bluetooth/hci0")).unwrap();
        assert_eq!(adapters_in(root.path()), Some(true));
    }

    #[test]
    fn no_sysfs_cannot_tell() {
        assert_eq!(adapters_in(Path::new("/no/such/sysfs")), None);
    }
}
