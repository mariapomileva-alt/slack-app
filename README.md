# Slack Channels Map

Slash command `/channels-map` opens a modal with filters and shows Slack channels.

## Setup

1. Create a Slack app at https://api.slack.com/apps
2. Enable **Slash Commands** and add:
   - Command: `/channels-map`
   - Request URL: `https://<your-domain>/slack/events`
   - Short description: `Open channels map`
3. Enable **Interactivity & Shortcuts** and set the Request URL:
   - `https://<your-domain>/slack/events`
4. Under **OAuth & Permissions**, add scopes:
   - `commands`
   - `chat:write`
5. Install the app to your workspace and copy:
   - **Bot User OAuth Token**
   - **Signing Secret**

## Run locally

```bash
cd slack-app
cp .env.example .env
npm install
npm run start
```

Expose your local server with a tunnel (ngrok, cloudflared) and paste the HTTPS
URL into the Slack app settings.

## Update data

The app reads `channels-data.json`. Regenerate it from the HTML file if needed:

```bash
python3 - <<'PY'
import json, re
from pathlib import Path
html = Path("../slack-channels-org.html").read_text(encoding="utf-8")
data = re.search(r"const data = (\\[.*?\\]);", html, re.S).group(1)
Path("channels-data.json").write_text(
    json.dumps(json.loads(data), ensure_ascii=False, indent=2),
    encoding="utf-8"
)
PY
```

## Auto-update from Google Sheets

If you want the app to read data directly from Google Sheets, set the env vars:

```
GOOGLE_SHEET_URL=https://docs.google.com/spreadsheets/d/<id>/edit?usp=sharing
GOOGLE_SHEET_TAB=Sheet1
```

The sheet can be public (anyone with the link). The app caches results for 5 minutes.
