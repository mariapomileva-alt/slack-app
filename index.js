require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

const LOCAL_DATA_PATH = path.join(__dirname, "channels-data.json");
const SHEET_URL = process.env.GOOGLE_SHEET_URL;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "";
const CACHE_TTL_MS = 5 * 60 * 1000;
let cached = { data: null, fetchedAt: 0 };

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

function normalize(text) {
  return String(text || "").toLowerCase();
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

function buildView({ data, keyword = "", groupTitle = "all" } = {}) {
  const options = buildOptions(data);
  const initialOption = options.find((o) => o.value === groupTitle);
  return {
    type: "modal",
    callback_id: "channels_map_filters",
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
  const data = await getData();
  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildView({ data }),
  });
});

app.view("channels_map_filters", async ({ ack, body }) => {
  try {
    const state = body.view.state.values;
    const keyword =
      state.keyword_block?.keyword_input?.value || "";
    const groupTitle =
      state.group_block?.group_select?.selected_option?.value || "all";

    const data = await getData();
    const view = buildView({ data, keyword, groupTitle });
    view.blocks = [
      ...view.blocks,
      ...buildResultsBlocks({ data, keyword, groupTitle }),
    ];

    await ack({
      response_action: "update",
      view,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("View submission error", error?.data || error);
    await ack();
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
