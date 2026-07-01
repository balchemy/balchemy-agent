# Partner Integration Checklist

## Discovery & Metadata

- [ ] Publish `/.well-known/erc8004-discovery.json`
- [ ] Publish `/.well-known/erc8004-onboarding.md`
- [ ] Publish `/.well-known/erc8004-skills-manifest.json`

## Onboarding

- [ ] Enable at least one onboarding mode (`siwe` or `walletless`)
- [ ] Verify `POST /api/public/erc8004/onboarding/siwe`
- [ ] Verify `POST /api/public/erc8004/onboarding/identity` (if walletless enabled)
- [ ] For Hub-managed agents, use the Hub agent Access/API key flow and the
      returned `POST /mcp/{publicId}` endpoint
- [ ] For walletless onboarding, complete the explicit MCP flow:
      `walletless/init` -> `walletless/provision` -> `walletless/bind-wallet`
      -> `setup_agent`
- [ ] Validate replay protection (token/jti reuse rejection)

## Headers and Claims

- [ ] `Authorization: Bearer <mcpApiKey>` on MCP calls
- [ ] Identity claims include `provider`, `subjectId`, `agentId`, `chainId`, `controllingAddress`
- [ ] Provider auth header and timeout configured

## Rate Limits

- [ ] Onboarding route limits configured and monitored
- [ ] Discovery feed and health endpoint limits configured

## MCP Exposure Boundaries

- [ ] Treat `balchemy-backend/src/core/tools/mcp-exposure.policy.ts` as the
      public MCP exposure source of truth
- [ ] Confirm default public tools and granular read-only tools are distinct
- [ ] Do not document raw provider, wallet mutation, withdrawal, approval,
      swap-bypass, or privileged manage helpers as public SDK APIs unless they
      are advertised by `tools/list` for the caller and scope
- [ ] Confirm live actions fail closed unless the backend runtime is
      `live_armed`, `armed=true`, `paused=false`, and policy/approval gates pass

## Operational

- [ ] JWKS endpoint reachable (`/.well-known/jwks.json`)
- [ ] Seed/failure telemetry visible in admin panel
- [ ] Kill-switches documented and tested
