export function desktopShareError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// Called inside the share-store mutation gate, never as a racy preflight read.
export function assertVacantDesktopShare(previous, ifAbsent) {
  if (ifAbsent && previous && !["expired", "revoked", "superseded"].includes(previous.status)
      && Date.parse(previous.expiresAt) > Date.now()) {
    throw desktopShareError("desktop_share_already_exists", 409);
  }
}
