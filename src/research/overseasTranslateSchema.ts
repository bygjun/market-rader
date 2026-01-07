export const OverseasTranslateJsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["overseas_competitor_updates"],
  properties: {
    overseas_competitor_updates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["company", "tag", "title"],
        properties: {
          company: { type: "string" },
          country: { type: "string" },
          tag: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          insight: { type: "string" },
        },
      },
    },
  },
} as const;

export const OverseasTranslateItemJsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["company", "tag", "title"],
  properties: {
    company: { type: "string" },
    country: { type: "string" },
    tag: { type: "string" },
    title: { type: "string" },
    url: { type: "string" },
    insight: { type: "string" },
  },
} as const;
