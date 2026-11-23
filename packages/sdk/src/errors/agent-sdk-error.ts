import type { AgentSdkErrorCode } from "./error-codes";
import { redactSecretLikeText, sanitizePublicErrorDetails } from "../utils/redaction";
import {
  extractFailureMetadata,
  type FailureLayer,
} from "./failure-metadata";

export class AgentSdkError extends Error {
  readonly code: AgentSdkErrorCode;
  readonly status?: number;
  readonly details?: unknown;
  readonly layer: FailureLayer;
  readonly machineCode: string;
  readonly source?: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(params: {
    code: AgentSdkErrorCode;
    message: string;
    status?: number;
    details?: unknown;
  }) {
    super(redactSecretLikeText(params.message));
    this.name = "AgentSdkError";
    this.code = params.code;
    this.status = params.status;
    this.details = sanitizePublicErrorDetails(params.details);
    const metadata = extractFailureMetadata({
      sdkCode: params.code,
      status: params.status,
      details: this.details,
    });
    this.layer = metadata.layer;
    this.machineCode = metadata.code;
    this.source = metadata.source;
    this.retryable = metadata.retryable;
    this.retryAfterSeconds = metadata.retryAfterSeconds;
  }
}
