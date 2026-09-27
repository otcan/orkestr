const stringValue = { type: "string" };

export const threadReleaseRoleUpdateSchema = {
  params: {
    type: "object",
    required: ["threadId"],
    properties: { threadId: stringValue },
    additionalProperties: false,
  },
  body: {
    type: "object",
    required: ["role"],
    properties: { role: stringValue },
    additionalProperties: false,
  },
};
