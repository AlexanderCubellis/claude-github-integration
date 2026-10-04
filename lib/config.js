export const FEATURES = ['review', 'summary', 'categorize', 'commit', 'tests', 'docs'];

export function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Configuration must be an object.');
  }
  const config = {
    model: input.model ?? 'claude-sonnet-4-6',
    maxTokens: Number(input.maxTokens ?? 2048),
    maxInputChars: Number(input.maxInputChars ?? 60000),
    prompt: input.prompt ?? '',
    features: typeof input.features === 'string'
      ? input.features.split(',').map(value => value.trim())
      : input.features ?? ['review'],
    publish: input.publish ?? 'comment',
  };
  if (typeof config.model !== 'string' || !config.model.trim() || config.model.length > 200) {
    throw new Error('Model must be a nonempty string of at most 200 characters.');
  }
  for (const [key, min, max] of [['maxTokens', 1, 8192], ['maxInputChars', 1000, 200000]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) {
      throw new Error(`${key} must be an integer between ${min} and ${max}.`);
    }
  }
  if (typeof config.prompt !== 'string' || config.prompt.length > 10000) {
    throw new Error('Prompt must be a string of at most 10000 characters.');
  }
  if (!Array.isArray(config.features) || !config.features.length ||
      config.features.some(value => !FEATURES.includes(value))) {
    throw new Error(`Features must contain only: ${FEATURES.join(', ')}.`);
  }
  if (!['comment', 'review', 'none'].includes(config.publish)) {
    throw new Error('Publish must be comment, review, or none.');
  }
  return config;
}
