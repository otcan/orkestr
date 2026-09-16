export interface UiSendFailureDescription {
  summary: string;
  detail: string;
  technical: string;
  retryable: boolean;
}

export function describeUiSendFailure(error: unknown): UiSendFailureDescription;
