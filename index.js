require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const data = require("./channels-data.json");

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

function getGroupTitles() {
  return data.map((g) => g.title).filter(Boolean);
}

function filterChannels({ keyword, groupTitle }) {
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

function buildOptions() {
  const options = [
    {
      text: { type: "plain_text", text: "All groups" },
      value: "all",
    },
  ];
  getGroupTitles().forEach((title) => {
    options.push({
      text: { type: "plain_text", text: title },
      value: title,
    });
  });
  return options;
}

function buildResultsBlocks({ keyword, groupTitle }) {
  const results = filterChannels({ keyword, groupTitle });
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

function buildView({ keyword = "", groupTitle = "all" } = {}) {
  const options = buildOptions();
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

app.command("/channels-map", async ({ ack, body, client }) => {
  await ack();
  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildView(),
  });
});

app.view("channels_map_filters", async ({ ack, body }) => {
  try {
    const state = body.view.state.values;
    const keyword =
      state.keyword_block?.keyword_input?.value || "";
    const groupTitle =
      state.group_block?.group_select?.selected_option?.value || "all";

    const view = buildView({ keyword, groupTitle });
    view.blocks = [
      ...view.blocks,
      ...buildResultsBlocks({ keyword, groupTitle }),
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
