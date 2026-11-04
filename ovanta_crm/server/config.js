import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  root,
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || path.join(root, 'data', 'ovantaa.db'),
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  baseUrl: (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  // Mail transport: "log" (simulated, default) or "webhook" (POST each message as JSON to MAIL_WEBHOOK_URL)
  mailTransport: process.env.MAIL_TRANSPORT || 'log',
  mailWebhookUrl: process.env.MAIL_WEBHOOK_URL || '',
  mailWebhookToken: process.env.MAIL_WEBHOOK_TOKEN || '',
  defaultFromName: process.env.FROM_NAME || 'Ovantaa CRM',
  defaultFromEmail: process.env.FROM_EMAIL || 'hello@ovantaa.example',
  companyAddress: process.env.COMPANY_ADDRESS || 'Ovantaa Inc., 100 Market Street, San Francisco, CA',
  sendBatchSize: Number(process.env.SEND_BATCH_SIZE || 25),
  sendDelayMs: Number(process.env.SEND_DELAY_MS || 50),
  seedDemo: process.env.SEED_DEMO !== '0',
  adminEmail: process.env.ADMIN_EMAIL || 'admin@ovantaa.com',
  adminPassword: process.env.ADMIN_PASSWORD || 'Ovantaa@123',
  secureCookies: process.env.SECURE_COOKIES === '1',
};

config.anthropicApiKey = process.env.ANTHROPIC_API_KEY || '';
config.anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
config.anthropicBaseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
// Only for internal relays / tests that present self-signed certificates. Leave unset for Gmail, Microsoft 365, Zoho etc.
config.smtpTlsInsecure = process.env.SMTP_TLS_INSECURE === '1';
// Workaround for networks where IPv6 connects but then stalls: connect to the server's IPv4 address only.
config.smtpForceIpv4 = process.env.SMTP_FORCE_IPV4 === '1';
