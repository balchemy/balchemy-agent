# Partner Integration Checklist

## Discovery & Metadata

- [ ] Publish `/.well-known/erc8004-discovery.json`
- [ ] Publish `/.well-known/erc8004-onboarding.md`
- [ ] Publish `/.well-known/erc8004-skills-manifest.json`

## Onboarding

- [ ] Enable at least one onboarding mode (`siwe` or `walletless`)
- [ ] Verify `POST /api/public/erc8004/onboarding/siwe`
- [ ] Verify `POST /api/public/erc8004/onboarding/identity` (if walletless enabled)
- [ ] If using Balchemy Studio, link `agentId` to `botId` from `My Bots -> MCP & Agents -> Agent Card -> External Agent Mapping`
- [ ] Validate replay protection (token/jti reuse rejection)

## Headers and Claims

- [ ] `Authorization: Bearer <mcpApiKey>` on MCP calls
- [ ] Identity claims include `provider`, `subjectId`, `agentId`, `chainId`, `controllingAddress`
- [ ] Provider auth header and timeout configured

## Rate Limits

- [ ] Onboarding route limits configured and monitored
- [ ] Discovery feed and health endpoint limits configured

## Operational

- [ ] JWKS endpoint reachable (`/.well-known/jwks.json`)
- [ ] Seed/failure telemetry visible in admin panel
- [ ] Kill-switches documented and tested
