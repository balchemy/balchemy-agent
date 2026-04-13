import { HttpClient } from "../client/http-client";
import type {
  IdentityTokenRevokeResponse,
  IdentityTokenRevokeStatusInput,
  OnboardWithIdentityInput,
  OnboardWithSiweInput,
  OnboardingResponse,
  RevokeIdentityTokenInput,
  RequestSiweNonceInput,
  SiweNonceResponse,
} from "../types";

export class AgentOnboardingClient {
  constructor(private readonly http: HttpClient) {}

  async requestSiweNonce(input: RequestSiweNonceInput): Promise<SiweNonceResponse> {
    return this.http.post<SiweNonceResponse>("/nest/auth/evm/nonce", {
      address: input.address,
      chainId: input.chainId,
      domain: input.domain,
      uri: input.uri,
      statement:
        input.statement ??
        "Sign in to Balchemy external agent onboarding",
    });
  }

  async onboardWithSiwe(input: OnboardWithSiweInput): Promise<OnboardingResponse> {
    return this.http.post<OnboardingResponse>(
      "/public/erc8004/onboarding/siwe",
      {
        message: input.message,
        signature: input.signature,
        agentId: input.agentId,
        ...(input.botId !== undefined ? { botId: input.botId } : {}),
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
      }
    );
  }

  async onboardWithIdentity(
    input: OnboardWithIdentityInput
  ): Promise<OnboardingResponse> {
    return this.http.post<OnboardingResponse>(
      "/public/erc8004/onboarding/identity",
      {
        provider: input.provider,
        identityToken: input.identityToken,
        agentId: input.agentId,
        ...(input.botId !== undefined ? { botId: input.botId } : {}),
        chainId: input.chainId ?? 8453,
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
      }
    );
  }

  async revokeIdentityToken(
    input: RevokeIdentityTokenInput
  ): Promise<IdentityTokenRevokeResponse> {
    return this.http.post<IdentityTokenRevokeResponse>(
      "/public/erc8004/onboarding/tokens/revoke",
      {
        jti: input.jti,
        ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
      }
    );
  }

  async getIdentityTokenRevokeStatus(
    input: IdentityTokenRevokeStatusInput
  ): Promise<IdentityTokenRevokeResponse> {
    return this.http.post<IdentityTokenRevokeResponse>(
      "/public/erc8004/onboarding/tokens/revoke-status",
      {
        jti: input.jti,
      }
    );
  }
}
