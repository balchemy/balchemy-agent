import type { AgentSdkErrorCode } from "./error-codes";

export class AgentSdkError extends Error {
  readonly code: AgentSdkErrorCode;
  readonly status?: number;
  readonly details?: unknown;

  constructor(params: {
    code: AgentSdkErrorCode;
    message: string;
    status?: number;
    details?: unknown;
  }) {
    super(params.message);
    this.name = "AgentSdkError";
    this.code = params.code;
    this.status = params.status;
    this.details = params.details;
  }
}
