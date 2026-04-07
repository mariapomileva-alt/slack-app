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
   - `conversations:read` (optional, for channel names in stats)
   - `users:read` and `users:read.email` (optional, for user names/emails in stats)
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

## Usage stats via Google Apps Script

You can store usage stats in a Google Sheet using Apps Script (no service account).

1) Create a new Google Sheet (e.g. "slack channel stat").
2) Extensions → Apps Script, paste this code and Deploy as Web App:

```javascript
function doPost(e) {
  var sheetName = 'Stats';
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['timestamp', 'eventType', 'userId', 'userName', 'userEmail', 'teamId', 'keyword', 'groupTitle', 'channelId', 'channelName', 'channelType']);
  }
  var body = JSON.parse(e.postData.contents || '{}');
  sheet.appendRow([
    body.timestamp || '',
    body.eventType || '',
    body.userId || '',
    body.userName || '',
    body.userEmail || '',
    body.teamId || '',
    body.keyword || '',
    body.groupTitle || '',
    body.channelId || '',
    body.channelName || '',
    body.channelType || ''
  ]);
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

3) Deploy → New deployment → Web app
   - Execute as: Me
   - Who has access: Anyone

4) Set env var:
```
STATS_APPS_SCRIPT_URL=https://script.google.com/macros/s/XXXX/exec
```

## Weekly metrics export to Google Sheets

The app can export weekly usage stats to Google Sheets. It writes a table with:
`Week`, `Total Commands`, `Group`, `Count`, `Last Used At`.

1. Create a Google Sheet for metrics and share it with a service account email.
2. Set one of:
   - `GOOGLE_SERVICE_ACCOUNT_JSON` (raw JSON or base64-encoded JSON)
   - `GOOGLE_SERVICE_ACCOUNT_PATH` (path to the JSON file)
3. Set the sheet id and tab:

```
GOOGLE_SHEETS_METRICS_SPREADSHEET_ID=your_spreadsheet_id
GOOGLE_SHEETS_METRICS_TAB=Metrics
```

The export is debounced (5s) and updates automatically on every `/channels-map` use.
