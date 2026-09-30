//! Request tokens let an HTTP producer cancel even after its body has ended but publication has not.

use super::state::ServerState;
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use redoor::{
    actors::router::{CancelPublicTransferError, RouterMsg},
    commands::{CancelUploadRequestResponse, ErrorResponse},
    types::TransferId,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

/// Entries live only as long as the owning HTTP handler, so completed requests cannot accumulate.
#[derive(Clone, Default)]
pub(crate) struct UploadRequests(Arc<Mutex<HashMap<Uuid, UploadRequestState>>>);

/// A reserved token records interruption before an agent worker has reported readiness.
#[derive(Clone, Copy, PartialEq, Debug)]
enum UploadRequestState {
    Starting { canceled: bool },
    Active(TransferId),
}

/// Removes only the mapping it owns when the handler finishes, fails or disconnects.
pub(crate) struct UploadRequestGuard {
    requests: UploadRequests,
    token: Uuid,
}

impl UploadRequests {
    /// Registers an optional caller-generated UUID without allowing duplicate requests to steal its mapping.
    pub(crate) fn reserve(
        &self,
        headers: &HeaderMap,
    ) -> Result<Option<UploadRequestGuard>, Box<Response>> {
        let Some(header) = headers.get("x-redoor-upload-request") else {
            return Ok(None);
        };
        let token = header
            .to_str()
            .ok()
            .and_then(|value| Uuid::parse_str(value).ok())
            .ok_or_else(|| {
                Box::new(
                    (
                        StatusCode::BAD_REQUEST,
                        Json(ErrorResponse {
                            error: "X-Redoor-Upload-Request must be a UUID".into(),
                        }),
                    )
                        .into_response(),
                )
            })?;
        let mut requests = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if requests.contains_key(&token) {
            return Err(Box::new(
                (
                    StatusCode::CONFLICT,
                    Json(ErrorResponse {
                        error: "Upload request token already active".into(),
                    }),
                )
                    .into_response(),
            ));
        }
        requests.insert(token, UploadRequestState::Starting { canceled: false });
        Ok(Some(UploadRequestGuard {
            requests: self.clone(),
            token,
        }))
    }
}

impl UploadRequestGuard {
    /// Refuses body forwarding when interruption happened during destination setup.
    pub(crate) fn activate(&self, id: TransferId) -> bool {
        let mut requests = self
            .requests
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if requests.get(&self.token) != Some(&UploadRequestState::Starting { canceled: false }) {
            return false;
        }
        requests.insert(self.token, UploadRequestState::Active(id));
        true
    }
}

impl Drop for UploadRequestGuard {
    /// CPU-only removal never holds a registry lock across IO or cancellation RPCs.
    fn drop(&mut self) {
        self.requests
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.token);
    }
}

/// DELETE /api/v1/upload-requests/{token} cancels exactly the matching still-owned upload.
pub(crate) async fn cancel_handler(
    State(state): State<ServerState>,
    Path(token): Path<Uuid>,
) -> Response {
    let request = {
        let mut requests = state
            .upload_requests
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match requests.get_mut(&token) {
            Some(UploadRequestState::Starting { canceled }) => {
                *canceled = true;
                Some(None)
            }
            Some(UploadRequestState::Active(id)) => Some(Some(*id)),
            None => None,
        }
    };
    let Some(id) = request else {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Upload request is no longer active".into(),
            }),
        )
            .into_response();
    };
    let Some(transfer_id) = id else {
        return Json(CancelUploadRequestResponse {
            request_token: token.to_string(),
            transfer: None,
        })
        .into_response();
    };
    match state
        .router_ref
        .request(5_000, |reply| RouterMsg::CancelPublicTransfer {
            transfer_id,
            reply,
        })
        .await
    {
        Ok(Ok(transfer)) => Json(CancelUploadRequestResponse {
            request_token: token.to_string(),
            transfer: Some(transfer),
        })
        .into_response(),
        Ok(Err(CancelPublicTransferError::NotFound)) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Upload transfer no longer retained".into(),
            }),
        )
            .into_response(),
        Ok(Err(CancelPublicTransferError::NotCancelable)) => (
            StatusCode::CONFLICT,
            Json(ErrorResponse {
                error: "Upload can no longer be canceled".into(),
            }),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to cancel upload request: {error:?}"),
            }),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Token mappings remain live until handler drop and cannot be stolen by another concurrent request.
    #[test]
    fn tokens_are_unique_and_scoped_to_handler_lifetime() {
        let requests = UploadRequests::default();
        let token = Uuid::new_v4();
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-redoor-upload-request",
            token.to_string().parse().unwrap(),
        );
        let guard = requests.reserve(&headers).unwrap().unwrap();
        assert!(
            guard.activate(TransferId::new(12)),
            "a live reservation must bind the actual worker id"
        );
        assert!(
            requests.reserve(&headers).is_err(),
            "duplicate tokens must not redirect cancellation to a competing upload"
        );
        assert_eq!(
            requests.0.lock().unwrap().get(&token),
            Some(&UploadRequestState::Active(TransferId::new(12))),
            "the original handler must retain cancellation ownership"
        );
        drop(guard);
        assert!(
            requests.0.lock().unwrap().is_empty(),
            "terminal handlers must not leak request correlations"
        );
        let guard = requests.reserve(&headers).unwrap().unwrap();
        requests
            .0
            .lock()
            .unwrap()
            .insert(token, UploadRequestState::Starting { canceled: true });
        assert!(
            !guard.activate(TransferId::new(99)),
            "a cancellation during setup must not revive body forwarding when readiness arrives"
        );
        drop(guard);
        headers.insert("x-redoor-upload-request", "invalid".parse().unwrap());
        assert!(
            requests.reserve(&headers).is_err(),
            "malformed correlation identifiers must not enter the registry"
        );
    }
}
