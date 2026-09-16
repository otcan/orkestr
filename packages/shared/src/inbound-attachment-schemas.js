export const inboundAttachmentStatusSchema = {
  querystring: {
    type: "object",
    required: ["threadId"],
    properties: { threadId: { type: "string", minLength: 1 } },
    additionalProperties: false,
  },
};

export const inboundAttachmentSessionCreateSchema = {
  body: {
    type: "object",
    required: ["threadId", "files"],
    properties: {
      threadId: { type: "string", minLength: 1 },
      files: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["idempotencyKey", "plaintextSize"],
          properties: {
            idempotencyKey: { type: "string", minLength: 8, maxLength: 160 },
            plaintextSize: { type: "integer" },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
};
