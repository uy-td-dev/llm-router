pub mod error;
pub mod stream;

pub use error::{is_rate_limited, Result, RouterError};
pub use stream::{StreamConverter, Wire, wire_for};

/// Simple glob match supporting a single leading/trailing/embedded '*'.
pub fn glob_match(pattern: &str, target: &str) -> bool {
    if let Some((prefix, suffix)) = pattern.split_once('*') {
        target.len() >= prefix.len() + suffix.len()
            && target.starts_with(prefix)
            && target.ends_with(suffix)
    } else {
        pattern == target
    }
}
