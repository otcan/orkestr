const stringValue = { type: "string" };
const objectValue = { type: "object", additionalProperties: true };

export function idParams(name) {
  return {
    params: {
      type: "object",
      required: [name],
      properties: {
        [name]: stringValue,
      },
      additionalProperties: false,
    },
  };
}

export const emptyObjectBody = {
  body: objectValue,
};

export const connectorConfigSchema = {
  body: objectValue,
};

export const connectorTestSchema = idParams("id");

export const gmailMessagesSchema = {
  querystring: {
    type: "object",
    properties: {
      maxResults: stringValue,
      q: stringValue,
    },
    additionalProperties: false,
  },
};

export const gmailMessageSchema = idParams("id");

export const whatsappInboundSchema = {
  body: {
    type: "object",
    properties: {
      eventId: stringValue,
      id: stringValue,
      messageId: stringValue,
      agentId: stringValue,
      targetAgentId: stringValue,
      threadId: stringValue,
      targetThreadId: stringValue,
      chatId: stringValue,
      fromChatId: stringValue,
      from: stringValue,
      sender: stringValue,
      author: stringValue,
      text: stringValue,
      body: stringValue,
      message: stringValue,
      promptFile: stringValue,
      accountId: stringValue,
      timestamp: stringValue,
      receivedAt: stringValue,
      attachments: {
        type: "array",
        items: objectValue,
      },
      chat: objectValue,
    },
    additionalProperties: true,
  },
};

export const browserActionSchema = idParams("slug");

export const agentTemplateSchema = idParams("templateId");

export const agentMessageSchema = {
  ...idParams("agentId"),
  body: {
    type: "object",
    properties: {
      role: stringValue,
      source: stringValue,
      text: stringValue,
      promptFile: stringValue,
      connector: stringValue,
      externalId: stringValue,
      chatId: stringValue,
      from: stringValue,
      accountId: stringValue,
      attachments: {
        type: "array",
        items: objectValue,
      },
    },
    additionalProperties: true,
  },
};

export const agentRunSchema = {
  ...idParams("agentId"),
  body: objectValue,
};

export const threadCreateSchema = {
  body: {
    type: "object",
    properties: {
      id: stringValue,
      threadId: stringValue,
      name: stringValue,
      title: stringValue,
      state: stringValue,
      executorId: stringValue,
      codexThreadId: stringValue,
      bindingName: stringValue,
      executor: objectValue,
      binding: objectValue,
    },
    additionalProperties: true,
  },
};

export const threadInputSchema = {
  ...idParams("threadId"),
  body: {
    type: "object",
    properties: {
      role: stringValue,
      source: stringValue,
      text: stringValue,
      promptFile: stringValue,
      connector: stringValue,
      externalId: stringValue,
      chatId: stringValue,
      from: stringValue,
      accountId: stringValue,
      attachments: {
        type: "array",
        items: objectValue,
      },
    },
    additionalProperties: true,
  },
};

export const threadInterruptSchema = {
  ...idParams("threadId"),
  body: {
    type: "object",
    properties: {
      text: stringValue,
      promptFile: stringValue,
      attachments: {
        type: "array",
        items: objectValue,
      },
    },
    additionalProperties: true,
  },
};

export const threadApproveSchema = {
  ...idParams("threadId"),
  body: {
    type: "object",
    properties: {
      text: stringValue,
      approval: stringValue,
      action: stringValue,
    },
    additionalProperties: true,
  },
};

export const threadWorkerCreateSchema = {
  ...idParams("threadId"),
  body: {
    type: "object",
    properties: {
      label: stringValue,
      task: stringValue,
      branchName: stringValue,
      remoteBranch: stringValue,
      autoRun: { type: "boolean" },
    },
    additionalProperties: true,
  },
};

export const threadBindingUpdateSchema = {
  ...idParams("threadId"),
  body: {
    type: "object",
    properties: {
      connector: stringValue,
      chatId: stringValue,
      displayName: stringValue,
      senderAccountId: stringValue,
      responderAccountId: stringValue,
      mirrorToWhatsApp: { type: "boolean" },
    },
    additionalProperties: true,
  },
};

export const threadRepoUpdateSchema = {
  ...idParams("threadId"),
  body: {
    type: "object",
    properties: {
      repoPath: stringValue,
      repoRemoteUrl: stringValue,
      branchName: stringValue,
      remoteBranch: stringValue,
      baseBranch: stringValue,
    },
    additionalProperties: true,
  },
};

export const threadRunSchema = {
  ...idParams("threadId"),
  body: objectValue,
};

export const timerCreateSchema = {
  body: {
    type: "object",
    properties: {
      label: stringValue,
      target: stringValue,
      targetType: stringValue,
      threadId: stringValue,
      agentId: stringValue,
      cadence: stringValue,
      time: stringValue,
      every: stringValue,
      runAt: stringValue,
      prompt: stringValue,
      promptFile: stringValue,
    },
    additionalProperties: true,
  },
};

export const timerIdSchema = idParams("timerId");

export const eventsSchema = {
  querystring: {
    type: "object",
    properties: {
      limit: stringValue,
    },
    additionalProperties: false,
  },
};
