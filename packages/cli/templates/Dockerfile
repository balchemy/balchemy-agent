# Balchemy Agent Docker image
# Node.js 20 slim — minimal surface area, no build tools

FROM node:20-slim

WORKDIR /app

# Install the agent SDK globally so runner is available as a binary
RUN npm install -g @balchemyai/agent-sdk create-balchemy-agent

# Copy user config files
COPY agent.config.yaml ./
COPY .env ./

# Health check: verify process is alive
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "process.exit(0)"

# Run the agent loop
CMD ["balchemy-agent", "start", "/app/agent.config.yaml"]
