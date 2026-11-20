const { sleep, vo } = require('../lib');
exports.run = async r => {
  await r.card('One platform. Every question.', 'Ask  ·  Verify  ·  Predict  ·  Report  ·  Govern', 'AskData', [
    'PostgreSQL, SQL Server, Oracle, MySQL, Snowflake, SingleStore', 'Excel and CSV folders, SAP sample data', 'Claude, OpenAI or your own AI model',
    'Forecasts, segments, anomalies and drivers', 'Reports as PDF and PowerPoint, scheduled by email', 'Chats shared with people and groups',
    'Separate companies, each with its own logo', 'Two-factor sign-in, row-level security, audit trail']);
  await sleep(await r.voice(vo('One platform for every question. Ask, verify, predict, report, and stay in control, with your data never leaving your own systems.')) + 1800);
  r.mark('hl-start');
  await r.card('Ask your data.\nTrust the answer.', '', 'Demo recorded with sample data');
  await sleep(await r.voice(vo('Ask your data. Trust the answer.')) + 3200);
  r.mark('hl-end');
};
