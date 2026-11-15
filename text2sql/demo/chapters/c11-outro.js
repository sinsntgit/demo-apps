const { sleep } = require('../lib');
exports.run = async r => {
  await r.card('One platform. Every question.', 'Ask  ·  Verify  ·  Predict  ·  Report  ·  Govern', 'AskData', [
    'PostgreSQL, SQL Server, Oracle, MySQL, Snowflake, SingleStore', 'Excel and CSV folders', 'Claude, OpenAI or your own AI model',
    'Forecasts, segments, anomalies and drivers', 'Drag-and-drop reports, scheduled by email', 'Two-factor sign-in, row-level security, audit trail']);
  await sleep(9000);
  await r.card('Ask your data.\nTrust the answer.', '', 'Demo recorded with sample data');
  await sleep(5200);
};
