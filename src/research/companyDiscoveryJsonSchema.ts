export const CompanyDiscoveryJsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["companies"],
  properties: {
    companies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["company", "category_id"],
        properties: {
          company: { type: "string" },
          category_id: { type: "string", enum: ["CAT-A", "CAT-B", "CAT-C", "CAT-D", "CAT-E"] },
          aliases: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;
