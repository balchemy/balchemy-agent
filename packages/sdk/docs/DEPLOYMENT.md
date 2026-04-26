# Deployment Guide

Your agent runs as a long-lived Node.js process. The recommended deployment targets
are a personal VPS ($4–7/mo) or a managed container platform (Railway, Render).

---

## Option A: Docker on a VPS (recommended)

This is the most reliable option. The agent runs in a Docker container that restarts
automatically on failure or reboot.

### Requirements

- Any Linux VPS with Docker installed (Ubuntu 22.04 LTS recommended)
- At least 256 MB RAM, 1 vCPU
- Providers: DigitalOcean, Hetzner, Vultr, Linode — all work fine

### Steps

**1. On your local machine:**

```bash
npx balchemy           # Setup wizard
npx balchemy docker    # Generate Dockerfile + docker-compose.yml
```

This creates:
```
Dockerfile
docker-compose.yml
.env.example         ← copy to .env, fill in credentials
agent.config.yaml    ← edit behavior_rules as needed
```

**2. Copy files to your VPS:**

```bash
scp Dockerfile docker-compose.yml agent.config.yaml .env user@your-vps:/home/user/agent/
```

**3. On your VPS:**

```bash
cd /home/user/agent
docker compose up -d
docker compose logs -f          # Watch logs
```

**4. Verify the agent is running:**

```bash
docker compose ps
# balchemy-agent   Up (healthy)
```

### Managing the agent

```bash
docker compose stop              # Graceful stop
docker compose start             # Start after stop
docker compose restart           # Restart
docker compose logs -f           # Tail logs
docker compose pull && docker compose up -d   # Update
```

### Updating config without rebuilding

The `agent.config.yaml` is mounted read-only into the container. Edit it on the
VPS and restart:

```bash
nano agent.config.yaml
docker compose restart
```

---

## Option B: Railway

Railway provides free-tier hosting for small containers.

1. Push your agent directory to a GitHub repo (exclude `.env`)
2. Create a new Railway project → Deploy from GitHub
3. Set environment variables in Railway dashboard:
   - `MCP_ENDPOINT`, `BALCHEMY_API_KEY`, `LLM_API_KEY`
4. Railway auto-detects `Dockerfile` and builds the image
5. Set restart policy to "Always"

---

## Option C: Render

Similar to Railway. Use Render's "Background Worker" service type (not Web Service).

1. Connect your GitHub repo
2. Select "Background Worker" (no port required)
3. Set environment variables in Render dashboard
4. Set "Restart Policy" to "Always"

---

## Option D: systemd daemon (Linux without Docker)

If you prefer to run the agent directly as a system service:

**1. Install globally:**

```bash
npm install -g balchemy
```

**2. Create a systemd unit file:**

```ini
# /etc/systemd/system/balchemy.service
[Unit]
Description=Balchemy Trading Agent
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/agent
ExecStart=/usr/bin/balchemy start /home/ubuntu/agent/agent.config.yaml
EnvironmentFile=/home/ubuntu/agent/.env
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**3. Enable and start:**

```bash
sudo systemctl daemon-reload
sudo systemctl enable balchemy
sudo systemctl start balchemy
sudo journalctl -u balchemy -f
```

---

## Security checklist

- `.env` must have permissions `600`: `chmod 600 .env`
- Never expose `agent.config.yaml` or `.env` via HTTP
- Use a non-root user inside the container (default Dockerfile uses `node` user)
- Rotate API keys regularly in Hub > Agents > API Keys
- Set `max_single_trade_usd` and `max_daily_loss_usd` to safe values before deploying

---

## Monitoring

The agent logs to stdout in this format:

```
[agent] status=running events=42 decisions=7 trades=2 llmCost=$0.0120/5.00
[agent] decision action=buy token=SOL amount=10 confidence=0.87
[agent] error: trade_command failed: insufficient balance
```

To forward logs to a log aggregator (e.g., Loki, Datadog):

```yaml
# In docker-compose.yml
logging:
  driver: loki
  options:
    loki-url: "http://your-loki-host:3100/loki/api/v1/push"
    loki-labels: "service=balchemy-agent"
```

---

## Troubleshooting

**Agent exits immediately:**
- Check `.env` — all required vars must be set
- Check `agent.config.yaml` — `mcp_endpoint` and `api_key` are required
- Run `docker compose logs` to see the error

**Agent starts but makes no decisions:**
- Verify your API key has `trade` scope (Hub > API Keys > Scopes)
- Check that your agent has a funded wallet
- Lower `min_confidence` in `behavior_rules`

**Budget exhausted quickly:**
- Reduce `max_daily_usd` in `llm` config
- Switch to a cheaper model (`claude-haiku-4-5` or `gpt-4o-mini`)
- Add more specific filters to avoid processing low-quality signals
