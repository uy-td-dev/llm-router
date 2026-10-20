use thiserror::Error;

#[derive(Debug, Error)]
pub enum RouterError {
    #[error("Provider error: {0}")]
    Provider(String),
    
    #[error("All providers failed")]
    AllProvidersFailed,
    
    #[error("Invalid request: {0}")]
    InvalidRequest(String),
    
    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Unauthorized: {0}")]
    Unauthorized(String),

    #[error("Forbidden: {0}")]
    Forbidden(String),

    #[error("Budget exceeded: {0}")]
    Budget(String),
    
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    
    #[error("Internal error: {0}")]
    Internal(String),
}

/// True when the failing provider indicates the account is out of
/// quota / rate limited. These errors rotate to another upstream
/// account first, then continue across providers transparently.
pub fn is_rate_limited(e: &RouterError) -> bool {
    match e {
        RouterError::Provider(msg) => {
            let m = msg.to_lowercase();
            m.contains("429")
                || m.contains("rate limit")
                || m.contains("ratelimit")
                || m.contains("quota")
                || m.contains("resource_exhausted")
                || m.contains("resource has been exhausted")
                || m.contains("too many requests")
                || m.contains("overloaded")
        }
        _ => false,
    }
}

pub type Result<T> = std::result::Result<T, RouterError>;
