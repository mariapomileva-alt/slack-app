require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { parse } = require("csv-parse/sync");

const LOCAL_DATA_PATH = path.join(__dirname, "channels-data.json");
const METRICS_PATH = path.join(__dirname, "channels-metrics.json");
const SHEET_URL = process.env.GOOGLE_SHEET_URL;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "";
const METRICS_SHEET_ID = process.env.GOOGLE_SHEETS_METRICS_SPREADSHEET_ID;
const METRICS_SHEET_TAB = process.env.GOOGLE_SHEETS_METRICS_TAB || "Metrics";
const METRICS_EXPORT_DEBOUNCE_MS = 5000;
const STATS_APPS_SCRIPT_URL = process.env.STATS_APPS_SCRIPT_URL;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CHANNEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const USER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let cached = { data: null, fetchedAt: 0 };
let metricsExportTimer = null;
let metricsExportInFlight = false;
let metricsExportPending = false;
let warnedMissingStatsUrl = false;
const channelCache = new Map();
const userCache = new Map();

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

const MAX_RESULTS = 60;
const MAX_LINES_PER_BLOCK = 18;
const MAX_TEXT_LENGTH = 2800;

function loadMetrics() {
  try {
    const stored = fs.readFileSync(METRICS_PATH, "utf-8");
    return JSON.parse(stored);
  } catch (error) {
    return {
      totalCommands: 0,
      groupSelections: {},
      lastUsedAt: null,
      weekly: {},
    };
  }
}

function saveMetrics(metrics) {
  try {
    fs.writeFileSync(METRICS_PATH, JSON.stringify(metrics, null, 2), "utf-8");
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Failed to write metrics", error?.message || error);
  }
}

function incrementMetric(metrics, groupTitle) {
  metrics.totalCommands += 1;
  metrics.lastUsedAt = new Date().toISOString();
  if (groupTitle) {
    metrics.groupSelections[groupTitle] =
      (metrics.groupSelections[groupTitle] || 0) + 1;
  }

  const weekKey = getWeekKey();
  if (!metrics.weekly) metrics.weekly = {};
  if (!metrics.weekly[weekKey]) {
    metrics.weekly[weekKey] = {
      totalCommands: 0,
      groupSelections: {},
      lastUsedAt: null,
    };
  }

  metrics.weekly[weekKey].totalCommands += 1;
  metrics.weekly[weekKey].lastUsedAt = metrics.lastUsedAt;
  if (groupTitle) {
    metrics.weekly[weekKey].groupSelections[groupTitle] =
      (metrics.weekly[weekKey].groupSelections[groupTitle] || 0) + 1;
  }
}

function normalize(text) {
  return String(text || "").toLowerCase();
}

function getWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function parseViewMetadata(view) {
  if (!view?.private_metadata) return {};
  try {
    return JSON.parse(view.private_metadata);
  } catch (error) {
    return {};
  }
}

async function resolveChannelInfo(client, channelId) {
  if (!channelId || !client) return {};
  const cachedEntry = channelCache.get(channelId);
  if (
    cachedEntry &&
    Date.now() - cachedEntry.fetchedAt < CHANNEL_CACHE_TTL_MS
  ) {
    return cachedEntry.data;
  }
  try {
    const info = await client.conversations.info({ channel: channelId });
    const channel = info?.channel || {};
    const data = {
      name: channel.name || channel.user || channel.id || "",
      type: channel.is_im
        ? "im"
        : channel.is_mpim
        ? "mpim"
        : channel.is_private
        ? "private"
        : "public",
    };
    channelCache.set(channelId, { data, fetchedAt: Date.now() });
    return data;
  } catch (error) {
    return {};
  }
}

async function resolveUserInfo(client, userId) {
  if (!userId || !client) return {};
  const cachedEntry = userCache.get(userId);
  if (
    cachedEntry &&
    Date.now() - cachedEntry.fetchedAt < USER_CACHE_TTL_MS
  ) {
    return cachedEntry.data;
  }
  try {
    const info = await client.users.info({ user: userId });
    const user = info?.user || {};
    const profile = user.profile || {};
    const data = {
      name: user.real_name || profile.real_name || user.name || "",
      email: profile.email || "",
    };
    userCache.set(userId, { data, fetchedAt: Date.now() });
    return data;
  } catch (error) {
    return {};
  }
}

function isMetricsExportConfigured() {
  return (
    Boolean(METRICS_SHEET_ID) &&
    Boolean(
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
        process.env.GOOGLE_SERVICE_ACCOUNT_PATH
    )
  );
}

function parseServiceAccount() {
  const jsonValue = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (jsonValue) {
    if (jsonValue.trim().startsWith("{")) {
      return JSON.parse(jsonValue);
    }
    const decoded = Buffer.from(jsonValue, "base64").toString("utf-8");
    return JSON.parse(decoded);
  }
  const filePath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH;
  if (filePath) {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  }
  return null;
}

async function exportWeeklyMetricsToSheets(metrics) {
  if (!isMetricsExportConfigured()) return;
  const credentials = parseServiceAccount();
  if (!credentials) return;

  const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  const sheets = google.sheets({ version: "v4", auth });

  const header = ["Week", "Total Commands", "Group", "Count", "Last Used At"];
  const rows = [header];
  const weekly = metrics.weekly || {};
  Object.keys(weekly)
    .sort()
    .forEach((weekKey) => {
      const weekData = weekly[weekKey] || {};
      const total = weekData.totalCommands || 0;
      const lastUsed = weekData.lastUsedAt || "";
      rows.push([weekKey, total, "ALL", total, lastUsed]);
      const groupSelections = weekData.groupSelections || {};
      Object.keys(groupSelections)
        .sort()
        .forEach((group) => {
          rows.push([weekKey, total, group, groupSelections[group], lastUsed]);
        });
    });

  await sheets.spreadsheets.values.clear({
    spreadsheetId: METRICS_SHEET_ID,
    range: METRICS_SHEET_TAB,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: METRICS_SHEET_ID,
    range: `${METRICS_SHEET_TAB}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });
}

async function sendStatsEvent(eventType, payload) {
  if (!STATS_APPS_SCRIPT_URL) {
    if (!warnedMissingStatsUrl) {
      warnedMissingStatsUrl = true;
      // eslint-disable-next-line no-console
      console.warn("STATS_APPS_SCRIPT_URL is not set; stats disabled.");
    }
    return;
  }
  try {
    const response = await fetch(STATS_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType,
        timestamp: new Date().toISOString(),
        ...payload,
      }),
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      // eslint-disable-next-line no-console
      console.error(
        "Stats webhook failed",
        response.status,
        bodyText || "<no body>"
      );
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Stats webhook error", error?.message || error);
  }
}

function scheduleMetricsExport() {
  if (!isMetricsExportConfigured()) return;
  if (metricsExportInFlight) {
    metricsExportPending = true;
    return;
  }
  if (metricsExportTimer) return;

  metricsExportTimer = setTimeout(async () => {
    metricsExportTimer = null;
    metricsExportInFlight = true;
    try {
      const metrics = loadMetrics();
      await exportWeeklyMetricsToSheets(metrics);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Metrics export failed", error?.message || error);
    } finally {
      metricsExportInFlight = false;
      if (metricsExportPending) {
        metricsExportPending = false;
        scheduleMetricsExport();
      }
    }
  }, METRICS_EXPORT_DEBOUNCE_MS);
}

function getGroupTitles(data) {
  return data.map((g) => g.title).filter(Boolean);
}

function filterChannels({ data, keyword, groupTitle }) {
  const kw = normalize(keyword);
  const groupMatch = groupTitle && groupTitle !== "all";

  const results = [];
  data.forEach((group) => {
    if (groupMatch && group.title !== groupTitle) return;
    const groupSections = [];

    group.sections.forEach((section) => {
      const channels = section.channels.filter((ch) => {
        if (!kw) return true;
        return (
          normalize(ch.channel).includes(kw) ||
          normalize(ch.description).includes(kw)
        );
      });
      if (channels.length) {
        groupSections.push({
          title: section.title,
          channels,
        });
      }
    });

    if (groupSections.length) {
      results.push({
        title: group.title,
        sections: groupSections,
      });
    }
  });

  return results;
}

function buildOptions(data) {
  const options = [
    {
      text: { type: "plain_text", text: "All groups" },
      value: "all",
    },
  ];
  getGroupTitles(data).forEach((title) => {
    options.push({
      text: { type: "plain_text", text: title },
      value: title,
    });
  });
  return options;
}

function buildResultsBlocks({ data, keyword, groupTitle }) {
  const results = filterChannels({ data, keyword, groupTitle });
  let totalChannels = 0;
  results.forEach((g) =>
    g.sections.forEach((s) => (totalChannels += s.channels.length))
  );

  const blocks = [
    {
      type: "divider",
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Results:* ${totalChannels} channels${
          keyword ? ` for _${keyword}_` : ""
        }${groupTitle && groupTitle !== "all" ? ` in *${groupTitle}*` : ""}.`,
      },
    },
  ];

  if (!totalChannels) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "No matches found. Try a different keyword or group.",
      },
    });
    return blocks;
  }

  let rendered = 0;
  const lines = [];
  for (const group of results) {
    lines.push(`*${group.title}*`);
    for (const section of group.sections) {
      if (section.title) {
        lines.push(`_${section.title}_`);
      }
      for (const ch of section.channels) {
        if (rendered >= MAX_RESULTS) break;
        const desc = ch.description ? ` — ${ch.description}` : "";
        lines.push(`• *${ch.channel}*${desc}`);
        rendered += 1;
      }
      if (rendered >= MAX_RESULTS) break;
    }
    if (rendered >= MAX_RESULTS) break;
  }

  let buffer = [];
  let bufferLength = 0;
  const flush = () => {
    if (!buffer.length) return;
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: buffer.join("\n") },
    });
    buffer = [];
    bufferLength = 0;
  };

  lines.forEach((line) => {
    const nextLength = bufferLength + line.length + 1;
    if (
      buffer.length >= MAX_LINES_PER_BLOCK ||
      nextLength >= MAX_TEXT_LENGTH
    ) {
      flush();
    }
    buffer.push(line);
    bufferLength = bufferLength + line.length + 1;
  });
  flush();

  if (rendered < totalChannels) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Showing first ${rendered} of ${totalChannels} channels.`,
        },
      ],
    });
  }

  if (process.env.PUBLIC_MAP_URL) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Full map: ${process.env.PUBLIC_MAP_URL}`,
      },
    });
  }

  return blocks;
}

function buildView({ data, keyword = "", groupTitle = "all", metadata } = {}) {
  const options = buildOptions(data);
  const initialOption = options.find((o) => o.value === groupTitle);
  return {
    type: "modal",
    callback_id: "channels_map_filters",
    ...(metadata
      ? { private_metadata: JSON.stringify(metadata).slice(0, 3000) }
      : {}),
    title: {
      type: "plain_text",
      text: "Channels Map",
    },
    submit: {
      type: "plain_text",
      text: "Apply",
    },
    close: {
      type: "plain_text",
      text: "Close",
    },
    blocks: [
      {
        type: "input",
        block_id: "keyword_block",
        optional: true,
        label: {
          type: "plain_text",
          text: "Search keyword",
        },
        element: {
          type: "plain_text_input",
          action_id: "keyword_input",
          initial_value: keyword || "",
          placeholder: {
            type: "plain_text",
            text: "e.g. marketing, support, #announcements",
          },
        },
      },
      {
        type: "input",
        block_id: "group_block",
        optional: true,
        label: {
          type: "plain_text",
          text: "Group",
        },
        element: {
          type: "static_select",
          action_id: "group_select",
          options,
          ...(initialOption ? { initial_option: initialOption } : {}),
        },
      },
    ],
  };
}

function buildLoadingView({
  data,
  keyword = "",
  groupTitle = "all",
  metadata,
} = {}) {
  const view = buildView({ data, keyword, groupTitle, metadata });
  view.blocks = [
    ...view.blocks,
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":hourglass_flowing_sand: Loading channels map...",
      },
    },
  ];
  return view;
}

function cleanCell(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseSheetRows(rows) {
  const headerRow = rows[0] || [];
  const dataRows = rows.slice(1);
  const blockCols = headerRow
    .map((val, idx) => (cleanCell(val) ? idx : -1))
    .filter((idx) => idx >= 0);

  const getCell = (row, idx) => (row && row[idx] !== undefined ? row[idx] : "");

  const nextNonEmptyValue = (col, startRow) => {
    for (let i = startRow; i < dataRows.length; i += 1) {
      const val = cleanCell(getCell(dataRows[i], col));
      if (val) return val;
    }
    return "";
  };

  const blocks = [];
  blockCols.forEach((col) => {
    const title = cleanCell(headerRow[col]);
    if (!title) return;

    const sections = [];
    let currentSection = { title: null, channels: [] };
    sections.push(currentSection);

    dataRows.forEach((row, idx) => {
      const name = cleanCell(getCell(row, col));
      const desc = cleanCell(getCell(row, col + 1));
      if (!name && !desc) return;
      if (name === "Channel" && (desc === "" || desc === "Description")) return;

      if (name && !desc) {
        const nextVal = nextNonEmptyValue(col, idx + 1);
        if (nextVal === "Channel") {
          currentSection = { title: name, channels: [] };
          sections.push(currentSection);
        } else {
          currentSection.channels.push({ channel: name, description: "" });
        }
        return;
      }

      if (name) {
        currentSection.channels.push({ channel: name, description: desc });
      }
    });

    const filtered = sections.filter(
      (section) => section.title || section.channels.length
    );
    blocks.push({ title, sections: filtered });
  });

  return blocks;
}

function sheetCsvUrl(sheetUrl, sheetTab) {
  const match = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) return "";
  const id = match[1];
  const base = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv`;
  if (!sheetTab) return base;
  return `${base}&sheet=${encodeURIComponent(sheetTab)}`;
}

async function fetchCsvWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Sheet fetch failed: ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function getData() {
  if (!SHEET_URL) {
    return JSON.parse(fs.readFileSync(LOCAL_DATA_PATH, "utf-8"));
  }

  const now = Date.now();
  if (cached.data && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const csvUrl = sheetCsvUrl(SHEET_URL, SHEET_TAB);
    const csv = await fetchCsvWithTimeout(csvUrl, 2000);
    const rows = parse(csv, { relax_quotes: true, relax_column_count: true });
    const parsed = parseSheetRows(rows);
    cached = { data: parsed, fetchedAt: now };
    return parsed;
  } catch (error) {
    if (cached.data) return cached.data;
    return JSON.parse(fs.readFileSync(LOCAL_DATA_PATH, "utf-8"));
  }
}

app.command("/channels-map", async ({ ack, body, client }) => {
  await ack();
  const dataSnapshot = cached.data || [];
  const metadata = {
    channelId: body.channel_id || "",
  };
  const metrics = loadMetrics();
  incrementMetric(metrics, "all");
  saveMetrics(metrics);
  scheduleMetricsExport();
  const openResult = await client.views.open({
    trigger_id: body.trigger_id,
    view: buildLoadingView({ data: dataSnapshot, metadata }),
  });

  try {
    const channelInfo = await resolveChannelInfo(client, body.channel_id);
    const userInfo = await resolveUserInfo(client, body.user_id);
    const enrichedMetadata = {
      ...metadata,
      channelName: channelInfo.name || "",
      channelType: channelInfo.type || "",
    };
    void sendStatsEvent("command_open", {
      userId: body.user_id,
      userName: userInfo.name || "",
      userEmail: userInfo.email || "",
      teamId: body.team_id,
      channelId: body.channel_id,
      channelName: channelInfo.name || "",
      channelType: channelInfo.type || "",
    });
    const data = await getData();
    const view = buildView({ data, metadata: enrichedMetadata });
    await client.views.update({
      view_id: openResult.view.id,
      hash: openResult.view.hash,
      view,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Failed to update view", error?.data || error);
  }
});

app.view("channels_map_filters", async ({ ack, body, client }) => {
  const state = body.view.state.values;
  const metadata = parseViewMetadata(body.view);
  const channelId = metadata.channelId || "";
  const userId = body.user?.id || "";
  const keyword = state.keyword_block?.keyword_input?.value || "";
  const groupTitle =
    state.group_block?.group_select?.selected_option?.value || "all";
  let acked = false;
  const ackOnce = async (payload) => {
    if (acked) return;
    acked = true;
    await ack(payload);
  };

  try {
    const metrics = loadMetrics();
    incrementMetric(metrics, groupTitle);
    saveMetrics(metrics);
    scheduleMetricsExport();
    const channelInfo =
      metadata.channelName || metadata.channelType
        ? { name: metadata.channelName || "", type: metadata.channelType || "" }
        : await resolveChannelInfo(client, channelId);
    const userInfo = await resolveUserInfo(client, userId);
    void sendStatsEvent("apply_filters", {
      userId,
      userName: userInfo.name || "",
      userEmail: userInfo.email || "",
      teamId: body.team?.id,
      keyword,
      groupTitle,
      channelId,
      channelName: channelInfo.name || "",
      channelType: channelInfo.type || "",
    });

    const dataSnapshot = cached.data || [];
    const loadingView = buildLoadingView({
      data: dataSnapshot,
      keyword,
      groupTitle,
      metadata: {
        ...metadata,
        channelName: channelInfo.name || metadata.channelName || "",
        channelType: channelInfo.type || metadata.channelType || "",
      },
    });
    await ackOnce({
      response_action: "update",
      view: loadingView,
    });

    const data = await getData();
    const view = buildView({ data, keyword, groupTitle, metadata });
    view.blocks = [
      ...view.blocks,
      ...buildResultsBlocks({ data, keyword, groupTitle }),
    ];
    await client.views.update({
      view_id: body.view.id,
      view,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("View submission error", error?.data || error);
    await ackOnce();
  }
});

app.error((error) => {
  // eslint-disable-next-line no-console
  console.error("Bolt error", error?.data || error);
});

const port = Number(process.env.PORT || 3000);
app.start(port).then(() => {
  // eslint-disable-next-line no-console
  console.log(`Slack app running on port ${port}`);
});
