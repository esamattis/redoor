use axum::http::{HeaderMap, header};

/// Enforces a browser WebSocket Origin authority against the HTTP Host authority.
pub(crate) fn is_same_origin(headers: &HeaderMap) -> bool {
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        // Non-browser clients have no ambient browser credentials to protect.
        return true;
    };
    let Ok(origin) = origin.parse::<axum::http::Uri>() else {
        return false;
    };
    matches!(origin.scheme_str(), Some("http" | "https"))
        && origin
            .authority()
            .map(|authority| authority.as_str().eq_ignore_ascii_case(host))
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Protects browser ambient credentials from cross-origin WebSocket use.
    #[test]
    fn validates_same_origin_authority() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "localhost:3000".parse().unwrap());
        headers.insert(header::ORIGIN, "http://localhost:3000".parse().unwrap());
        // A matching browser authority is permitted even though WebSocket uses another scheme.
        assert!(is_same_origin(&headers));
        headers.insert(header::ORIGIN, "https://attacker.example".parse().unwrap());
        // A cross-site browser cannot use ambient session access to open a privileged stream.
        assert!(!is_same_origin(&headers));
    }
}
