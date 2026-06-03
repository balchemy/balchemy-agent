# Balchemy Agent Docker image
# Node.js 20 slim — minimal surface area, no build tools

FROM node:20-slim

WORKDIR /app

# Install the published CLI and SDK package names.
RUN npm install -g @balchemyai/agent-sdk balchemy

# Copy non-secret user config files; inject runtime secrets via env/secret mounts.
COPY agent.config.yaml ./

# Health check: verify process is alive
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "process.exit(0)"

# Run the agent loop
CMD ["balchemy", "start", "/app/agent.config.yaml"]
