import "dotenv/config";
import { loadGeminiEnv } from "../lib/env.js";
import { listModels, normalizeModelName } from "../research/models.js";

async function main(): Promise<void> {
  const env = loadGeminiEnv();
  const models = await listModels(env.GEMINI_API_KEY);
  for (const m of models) {
    if (!m.name) continue;
    const name = normalizeModelName(m.name);
    const methods = (m.supportedGenerationMethods ?? []).join(", ");
    // eslint-disable-next-line no-console
    console.log(`${name}\t${methods}`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

