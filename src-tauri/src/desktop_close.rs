//! In-memory ownership for the native/renderer close handshake. No draft values.
use serde::Serialize;

pub(crate) const INTENT_EVENT: &str = "maobu-desktop-close-intent";
pub(crate) const RESOLVED_EVENT: &str = "maobu-desktop-close-resolved";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloseIntent {
    pub session_id: String,
    pub request_id: String,
    pub delivery_id: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Awaiting,
    Continuing,
}
#[derive(Clone, Debug)]
struct Pending {
    intent: CloseIntent,
    phase: Phase,
    acknowledged: bool,
}

#[derive(Default)]
pub(crate) struct CloseGate {
    session_id: Option<String>,
    pending: Option<Pending>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Resolution {
    Cancelled,
    Continuing,
    Holding,
    Stale,
}

impl CloseGate {
    pub fn awaiting(&self) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|pending| pending.phase == Phase::Awaiting)
    }
    pub fn register(&mut self, session_id: String) -> Result<Option<CloseIntent>, String> {
        if self
            .pending
            .as_ref()
            .is_some_and(|pending| pending.phase == Phase::Continuing)
        {
            return Err("Desktop shutdown is already in progress".into());
        }
        let cancelled = self.pending.take().map(|pending| pending.intent);
        self.session_id = Some(session_id);
        Ok(cancelled)
    }
    pub fn unregister(&mut self, session_id: &str) -> Option<CloseIntent> {
        if self.session_id.as_deref() != Some(session_id) {
            return None;
        }
        self.session_id = None;
        if self
            .pending
            .as_ref()
            .is_some_and(|pending| pending.phase == Phase::Awaiting)
        {
            self.pending.take().map(|pending| pending.intent)
        } else {
            None
        }
    }
    pub fn begin(&mut self, request_id: String) -> Option<CloseIntent> {
        if self.pending.is_some() {
            return None;
        }
        let intent = CloseIntent {
            session_id: self.session_id.clone()?,
            request_id,
            delivery_id: 1,
        };
        self.pending = Some(Pending {
            intent: intent.clone(),
            phase: Phase::Awaiting,
            acknowledged: false,
        });
        Some(intent)
    }
    pub fn retry_delivery(&mut self) -> Option<CloseIntent> {
        let pending = self.pending.as_mut()?;
        if pending.phase != Phase::Awaiting {
            return None;
        }
        pending.intent.delivery_id = pending.intent.delivery_id.checked_add(1)?;
        pending.acknowledged = false;
        Some(pending.intent.clone())
    }
    pub fn hold(&mut self, session_id: &str, request_id: &str, delivery_id: u32) -> Resolution {
        let Some(pending) = self.pending.as_mut() else {
            return Resolution::Stale;
        };
        if pending.intent.session_id != session_id
            || pending.intent.request_id != request_id
            || pending.intent.delivery_id != delivery_id
            || pending.phase != Phase::Awaiting
        {
            return Resolution::Stale;
        }
        pending.acknowledged = true;
        Resolution::Holding
    }
    pub fn resolve(&mut self, session_id: &str, request_id: &str, proceed: bool) -> Resolution {
        let Some(pending) = self.pending.as_mut() else {
            return Resolution::Stale;
        };
        if pending.intent.session_id != session_id
            || pending.intent.request_id != request_id
            || pending.phase != Phase::Awaiting
        {
            return Resolution::Stale;
        }
        if proceed {
            pending.phase = Phase::Continuing;
            Resolution::Continuing
        } else {
            self.pending = None;
            Resolution::Cancelled
        }
    }
    pub fn cancel_awaiting(&mut self, intent: &CloseIntent) -> bool {
        if self.pending.as_ref().is_some_and(|pending| {
            pending.intent == *intent && pending.phase == Phase::Awaiting && !pending.acknowledged
        }) {
            self.pending = None;
            true
        } else {
            false
        }
    }
    pub fn finish_cancel(&mut self, intent: &CloseIntent) -> bool {
        if self.pending.as_ref().is_some_and(|pending| {
            pending.intent.session_id == intent.session_id
                && pending.intent.request_id == intent.request_id
        }) {
            self.pending = None;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_current_token_can_proceed_only_once_and_old_sessions_cannot_act() {
        let mut gate = CloseGate::default();
        assert!(gate.begin("not-ready".into()).is_none());
        gate.register("session-a".into()).unwrap();
        let intent = gate.begin("request-a".into()).unwrap();
        assert!(gate.begin("duplicate".into()).is_none());
        assert_eq!(
            gate.resolve("old-session", &intent.request_id, true),
            Resolution::Stale
        );
        assert_eq!(
            gate.resolve(&intent.session_id, "old-request", true),
            Resolution::Stale
        );
        assert_eq!(
            gate.resolve(&intent.session_id, &intent.request_id, true),
            Resolution::Continuing
        );
        assert_eq!(
            gate.resolve(&intent.session_id, &intent.request_id, true),
            Resolution::Stale
        );
        assert_eq!(
            gate.resolve(&intent.session_id, &intent.request_id, false),
            Resolution::Stale
        );
        assert!(
            !gate.cancel_awaiting(&intent),
            "A timeout must not cancel cleanup that already started"
        );
        assert!(gate.register("replacement".into()).is_err());
        assert!(gate.finish_cancel(&intent));
        assert_eq!(
            gate.resolve(&intent.session_id, &intent.request_id, true),
            Resolution::Stale
        );
    }
    #[test]
    fn cancellation_disconnect_and_replacement_never_approve_a_close() {
        let mut gate = CloseGate::default();
        gate.register("one".into()).unwrap();
        let first = gate.begin("first".into()).unwrap();
        assert_eq!(gate.resolve("one", "first", false), Resolution::Cancelled);
        assert_eq!(gate.resolve("one", "first", true), Resolution::Stale);
        let second = gate.begin("second".into()).unwrap();
        assert!(gate.unregister("stale").is_none());
        assert_eq!(gate.register("two".into()).unwrap(), Some(second));
        assert_eq!(
            gate.resolve(&first.session_id, &first.request_id, true),
            Resolution::Stale
        );
        let third = gate.begin("third".into()).unwrap();
        assert_eq!(gate.unregister("two"), Some(third));
        assert!(gate.begin("disconnected".into()).is_none());
    }
    #[test]
    fn timeout_only_cancels_the_exact_pending_frontend_request() {
        let mut gate = CloseGate::default();
        gate.register("session".into()).unwrap();
        let first = gate.begin("one".into()).unwrap();
        assert!(gate.cancel_awaiting(&first));
        let second = gate.begin("two".into()).unwrap();
        assert!(!gate.cancel_awaiting(&first));
        assert_eq!(
            gate.resolve(&second.session_id, &second.request_id, true),
            Resolution::Continuing
        );
        assert!(!gate.finish_cancel(&first));
        assert!(gate.finish_cancel(&second));
    }
    #[test]
    fn a_live_review_is_not_timed_out_but_retry_detects_a_lost_renderer() {
        let mut gate = CloseGate::default();
        gate.register("session".into()).unwrap();
        let first = gate.begin("one".into()).unwrap();
        assert_eq!(
            gate.hold("session", "one", first.delivery_id),
            Resolution::Holding
        );
        assert!(!gate.cancel_awaiting(&first));
        let retry = gate.retry_delivery().unwrap();
        assert_eq!(retry.request_id, first.request_id);
        assert!(retry.delivery_id > first.delivery_id);
        assert_eq!(
            gate.hold("session", "one", first.delivery_id),
            Resolution::Stale
        );
        assert!(!gate.cancel_awaiting(&first));
        assert!(
            gate.cancel_awaiting(&retry),
            "An unacknowledged re-delivery enables explicit native recovery, never automatic exit"
        );
    }
}
