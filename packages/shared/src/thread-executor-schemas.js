import { idParams } from "./api-schemas.js";

const stringValue = { type: "string" };

export const threadExecutorUpdateSchema = {
  ...idParams("threadId"),
  body: {
    type: "object",
    required: ["executor"],
    properties: {
      executor: stringValue,
      model: stringValue,
      effort: stringValue,
      profileId: stringValue,
      when: stringValue,
      reason: stringValue,
      actor: stringValue,
    },
    additionalProperties: false,
  },
};
