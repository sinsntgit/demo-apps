const { sleep, vo } = require('../lib');
exports.run = async r => {
  r.mark('hl-start');
  await r.card('AskData', 'Ask your data anything — in plain English.', 'Text-to-SQL · Predictive analytics · Reports');
  await sleep(await r.voice(vo('AskData lets anyone in your business ask questions of their own data, in plain English, and get answers they can trust.')) + 1000);
  r.mark('hl-end');
  await r.card('Answers from your own data', 'The AI writes the SQL. Your database runs it. Your query results never go to the AI.', 'Privacy by design');
  await sleep(await r.voice(vo('The A I writes the S Q L. Your database runs it, read only. And your query results never go to the A I.')) + 1000);
  await r.card('A complete tour', '', 'What you are about to see', [
    'Ask in plain English — and rephrase first', 'Check, correct and teach it', 'Forecast, segment, find anomalies', 'Reports, PowerPoint and email on schedule',
    'Share chats; separate companies', 'Results-only users and reviewed problems', 'Row-level security and a full audit trail', 'SAP sample data, databases, Excel and CSV']);
  await sleep(await r.voice(vo('In this tour: asking and rephrasing questions, checking and correcting answers, forecasting, reports and PowerPoint, sharing, separate companies, and security.')) + 1500);
};
