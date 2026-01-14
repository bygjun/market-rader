export const WeeklyReportJsonSchema = {
  type: "object",
  additionalProperties: true,
  required: [
    "report_date",
    "week_number",
    "top_highlights",
    "category_updates",
    "overseas_competitor_updates",
    "hiring_signals",
    "action_items",
  ],
  properties: {
    report_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    week_number: { type: "integer", minimum: 1, maximum: 53 },
    company_homepages: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    top_highlights: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["company", "category", "title", "insight", "importance_score"],
        properties: {
          company: { type: "string" },
          category: { type: "string", enum: ["CAT-A", "CAT-B", "CAT-C", "CAT-D", "CAT-E"] },
          title: { type: "string" },
          insight: { type: "string" },
          importance_score: { type: "integer", minimum: 1, maximum: 5 },
          link: { type: "string" },
        },
      },
    },
    category_updates: {
      type: "object",
      additionalProperties: true,
      required: ["CAT-A", "CAT-B", "CAT-C", "CAT-D", "CAT-E"],
      properties: {
        "CAT-A": {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["company", "tag", "title"],
            properties: {
              company: { type: "string" },
              tag: { type: "string" },
              title: { type: "string" },
              url: { type: "string" },
              insight: { type: "string" },
            },
          },
        },
        "CAT-B": {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["company", "tag", "title"],
            properties: {
              company: { type: "string" },
              tag: { type: "string" },
              title: { type: "string" },
              url: { type: "string" },
              insight: { type: "string" },
            },
          },
        },
        "CAT-C": {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["company", "tag", "title"],
            properties: {
              company: { type: "string" },
              tag: { type: "string" },
              title: { type: "string" },
              url: { type: "string" },
              insight: { type: "string" },
            },
          },
        },
        "CAT-D": {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["company", "tag", "title"],
            properties: {
              company: { type: "string" },
              tag: { type: "string" },
              title: { type: "string" },
              url: { type: "string" },
              insight: { type: "string" },
            },
          },
        },
        "CAT-E": {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["company", "tag", "title"],
            properties: {
              company: { type: "string" },
              tag: { type: "string" },
              title: { type: "string" },
              url: { type: "string" },
              insight: { type: "string" },
            },
          },
        },
      },
    },
    overseas_competitor_updates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["company", "tag", "title"],
        properties: {
          company: { type: "string" },
          country: { type: "string" },
          category: { type: "string", enum: ["CAT-A", "CAT-B", "CAT-C", "CAT-D", "CAT-E"] },
          tag: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          insight: { type: "string" },
        },
      },
    },
    hiring_signals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["company", "position", "strategic_inference"],
        properties: {
          company: { type: "string" },
          position: { type: "string" },
          strategic_inference: { type: "string" },
          url: { type: "string" },
        },
      },
    },
    action_items: { type: "array", items: { type: "string" } },
  },
} as const;
