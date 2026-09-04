function idParams(name) {
  return {
    params: {
      type: "object",
      required: [name],
      properties: {
        [name]: { type: "string" },
      },
      additionalProperties: false,
    },
  };
}

// Hush is a device-bound mobile surface. Its authenticated device profile
// selects the target thread on the server; callers may submit only text and a
// client-generated idempotency key. Raw audio, thread IDs, and command/control
// switches are deliberately absent from this boundary.
export const mobileVoiceTurnSchema = {
  body: {
    type: "object",
    required: ["clientTurnId", "transcript", "locale"],
    properties: {
      clientTurnId: { type: "string", strict: true, minLength: 36, maxLength: 64 },
      transcript: { type: "string", strict: true, minLength: 1, maxLength: 12000 },
      locale: { type: "string", strict: true, minLength: 1, maxLength: 64 },
    },
    additionalProperties: false,
  },
};

export const mobileVoiceTurnParamsSchema = idParams("turnId");

export const mobileRealtimeCallSchema = {
  body: {
    type: "object",
    required: ["clientCallId", "offerSdp"],
    properties: {
      clientCallId: { type: "string", strict: true, minLength: 36, maxLength: 64 },
      offerSdp: { type: "string", strict: true, minLength: 8, maxLength: 65_536 },
    },
    additionalProperties: false,
  },
};

export const mobileRealtimeCallParamsSchema = idParams("callId");

export const mobilePushTokenSchema = {
  body: {
    type: "object",
    required: ["token", "environment", "operation"],
    properties: {
      token: { type: "string", strict: true, minLength: 16, maxLength: 4096 },
      environment: { type: "string", enum: ["sandbox", "production"] },
      operation: { type: "string", enum: ["upsert", "remove"] },
    },
    additionalProperties: false,
  },
};

export const mobileLiveActivityTokenSchema = {
  body: {
    type: "object",
    required: ["activityId", "token", "environment", "operation"],
    properties: {
      activityId: { type: "string", strict: true, minLength: 1, maxLength: 160 },
      token: { type: "string", strict: true, minLength: 16, maxLength: 4096 },
      environment: { type: "string", enum: ["sandbox", "production"] },
      operation: { type: "string", enum: ["upsert", "remove"] },
    },
    additionalProperties: false,
  },
};

const mobileDevicePublicKeySchema = {
  type: "object",
  required: ["kty", "crv", "x", "y"],
  properties: {
    kty: { type: "string", enum: ["EC"] },
    crv: { type: "string", enum: ["P-256"] },
    x: { type: "string", strict: true, minLength: 1, maxLength: 128 },
    y: { type: "string", strict: true, minLength: 1, maxLength: 128 },
  },
  additionalProperties: false,
};

export const mobilePairingStartSchema = {
  body: {
    type: "object",
    required: ["deviceName", "publicKeyJwk"],
    properties: {
      deviceName: { type: "string", strict: true, minLength: 1, maxLength: 120 },
      publicKeyJwk: mobileDevicePublicKeySchema,
      machineContext: {
        type: "object",
        properties: {
          platform: { type: "string", strict: true, maxLength: 32 },
          appVersion: { type: "string", strict: true, maxLength: 64 },
          deviceName: { type: "string", strict: true, maxLength: 120 },
          osVersion: { type: "string", strict: true, maxLength: 64 },
          installationId: { type: "string", strict: true, maxLength: 160 },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
};

export const mobilePairingParamsSchema = idParams("pairingId");

export const mobilePairingPollSchema = {
  ...mobilePairingParamsSchema,
  querystring: {
    type: "object",
    required: ["pollToken"],
    properties: { pollToken: { type: "string", strict: true, minLength: 32, maxLength: 160 } },
    additionalProperties: false,
  },
};

export const mobilePairingCompleteSchema = {
  ...mobilePairingParamsSchema,
  body: {
    type: "object",
    required: ["pollToken", "challengeId", "proof"],
    properties: {
      pollToken: { type: "string", strict: true, minLength: 32, maxLength: 160 },
      challengeId: { type: "string", strict: true, minLength: 8, maxLength: 160 },
      proof: { type: "string", strict: true, minLength: 32, maxLength: 4096 },
    },
    additionalProperties: false,
  },
};

export const mobileSessionRefreshSchema = {
  body: {
    type: "object",
    required: ["refreshToken"],
    properties: {
      refreshToken: { type: "string", strict: true, minLength: 32, maxLength: 256 },
    },
    additionalProperties: false,
  },
};

export const mobilePairingApprovalSchema = {
  params: {
    type: "object",
    required: ["profileId"],
    properties: { profileId: { type: "string", strict: true, minLength: 1, maxLength: 96 } },
    additionalProperties: false,
  },
  body: {
    type: "object",
    required: ["pairingCode"],
    properties: { pairingCode: { type: "string", strict: true, minLength: 4, maxLength: 32 } },
    additionalProperties: false,
  },
};

export const mobileDeviceParamsSchema = idParams("deviceId");
