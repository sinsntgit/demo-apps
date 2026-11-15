const { sleep } = require('../lib');
exports.run = async r => {
  await r.card('AskData', 'Ask your data anything — in plain English.', 'Text-to-SQL · Predictive analytics · Reports');
  await sleep(4400);
  await r.card('Answers from your own data', 'The AI writes the SQL. Your database runs it. Your query results never go to the AI.', 'Privacy by design');
  await sleep(5400);
  await r.card('A nine-minute tour', '', 'What you are about to see', [
    'Ask in plain English', 'Check, correct and teach it', 'Forecast, segment, find anomalies', 'Reports that refresh and email themselves',
    'Row-level security and a full audit trail', 'Databases, Excel and CSV files']);
  await sleep(7600);
};
