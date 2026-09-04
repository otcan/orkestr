function text(value = "") {
  return String(value || "").trim();
}

export function clientMobilePairing(pairing = {}, { includeApproveCode = false } = {}) {
  return {
    id: text(pairing.id),
    ...(includeApproveCode ? { approveCode: text(pairing.approveCode) } : {}),
    status: text(pairing.status) || "pending",
    createdAt: text(pairing.createdAt),
    expiresAt: text(pairing.expiresAt),
  };
}

export function ownerMobilePairing(pairing = {}) {
  return {
    id: text(pairing.id),
    status: text(pairing.status) || "pending",
    deviceName: text(pairing.deviceName),
    createdAt: text(pairing.createdAt),
    expiresAt: text(pairing.expiresAt),
    approvedAt: text(pairing.approvedAt),
  };
}

export function ownerMobileProfile(profile = {}) {
  return {
    id: text(profile.id),
    label: text(profile.label) || "Managed Hush profile",
    status: profile.enabled === false ? "disabled" : "active",
  };
}

export function ownerMobileDevice(device = {}, session = null) {
  return {
    id: text(device.id),
    label: text(device.deviceName) || "Hush device",
    status: text(device.status) === "active" ? "paired" : text(device.status) || "unavailable",
    pairedAt: text(device.createdAt) || null,
    lastSeenAt: text(device.lastAccessedAt) || null,
    expiresAt: text(session?.refreshExpiresAt) || null,
  };
}

export function clientMobileSession(session = {}) {
  return {
    id: text(session.id),
    deviceId: text(session.deviceId),
    accessExpiresAt: text(session.accessExpiresAt),
    refreshExpiresAt: text(session.refreshExpiresAt),
  };
}
