// A preserving restoration probe emits auth_failure locally when WhatsApp Web
// asks for authentication. That event is not proof of device deregistration.
export function authenticationFailureEvidence({ preservingProbe = false, previous = {}, at }) {
  return {
    verifiedLogoutAt: preservingProbe ? previous.verifiedLogoutAt || null : at,
    clearPairedRegistration: !preservingProbe,
    failureKind: preservingProbe ? "saved_session_restore_failed" : "authentication_failed",
  };
}
