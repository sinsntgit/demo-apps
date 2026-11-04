import crypto from 'node:crypto';
import { get, run, tx, db, all } from './db.js';
import { config } from './config.js';
import { hashPassword } from './auth.js';

// deterministic PRNG so demo data is stable
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 19).replace('T', ' ');
const dateOffset = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

export function seedIfEmpty() {
  if (get('SELECT COUNT(*) n FROM users').n > 0) return;
  console.log('First run: creating admin user' + (config.seedDemo ? ' and demo data' : ''));
  tx(() => {
    const pw = hashPassword(config.adminPassword);
    run("INSERT INTO users (name,email,password_hash,role) VALUES ('Admin User',?,?,'admin')", config.adminEmail, pw);
    if (!config.seedDemo) return;
    run("INSERT INTO users (name,email,password_hash,role) VALUES ('Maya Patel','maya@ovantaa.com',?,'manager')", pw);
    run("INSERT INTO users (name,email,password_hash,role) VALUES ('Liam Chen','liam@ovantaa.com',?,'rep')", pw);
    run("INSERT INTO users (name,email,password_hash,role) VALUES ('Sofia Rossi','sofia@ovantaa.com',?,'rep')", pw);
    const uids = [1, 2, 3, 4];

    const industries = ['Software', 'Manufacturing', 'Healthcare', 'Finance', 'Retail', 'Logistics', 'Education', 'Energy'];
    const places = [['San Francisco', 'USA'], ['Austin', 'USA'], ['New York', 'USA'], ['London', 'UK'], ['Berlin', 'Germany'], ['Mumbai', 'India'], ['Singapore', 'Singapore'], ['Toronto', 'Canada']];
    const sizes = ['1-50', '51-200', '201-1000', '1000+'];
    const names = ['Northwind', 'Contoso', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark', 'Wayne', 'Acme', 'Vandelay', 'Soylent', 'Wonka', 'Tyrell', 'Cyberdyne', 'Aperture', 'Massive Dynamic', 'Pied Piper', 'Dunder', 'Oscorp', 'Gringotts', 'Monarch', 'Blue Sun', 'Nakatomi', 'Duff', 'Prestige'];
    const suffix = ['Systems', 'Labs', 'Group', 'Partners', 'Holdings', 'Industries', 'Co'];
    const accIds = [];
    for (const n of names) {
      const [city, country] = pick(places);
      const name = `${n} ${pick(suffix)}`;
      accIds.push([Number(run('INSERT INTO accounts (name,industry,website,size,city,country,phone,owner_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        name, pick(industries), `https://www.${n.toLowerCase().replace(/\s/g, '')}.example`, pick(sizes), city, country, `+1-555-01${int(10, 99)}`, pick(uids), daysAgo(int(5, 400))).lastInsertRowid), n]);
    }
    const first = ['Ava', 'Noah', 'Emma', 'Oliver', 'Isla', 'Ethan', 'Mia', 'Lucas', 'Zoe', 'Arjun', 'Priya', 'Hiro', 'Chloe', 'Omar', 'Nina', 'Diego', 'Fatima', 'Jonas', 'Leila', 'Marco', 'Anya', 'Kofi', 'Elena', 'Ravi'];
    const last = ['Smith', 'Garcia', 'Kim', 'Nguyen', 'Brown', 'Singh', 'Khan', 'Müller', 'Silva', 'Ivanov', 'Tanaka', 'Okafor', 'Dubois', 'Rossi', 'Cohen', 'Lopez'];
    const titles = ['CEO', 'CTO', 'VP Sales', 'Marketing Director', 'Head of Operations', 'Procurement Manager', 'IT Manager', 'Product Manager', 'CFO', 'Founder'];
    const sources = ['Website', 'Referral', 'Webinar', 'LinkedIn', 'Trade show', 'Cold outreach'];
    const tags = ['enterprise', 'smb', 'newsletter', 'webinar-2026', 'decision-maker', 'partner', 'vip'];
    const used = new Set(); const contactIds = [];
    for (let i = 0; i < 90; i++) {
      const f = pick(first), l = pick(last); const [aid, an] = pick(accIds);
      let email = `${f}.${l}`.toLowerCase().normalize('NFD').replace(/[^a-z.]/g, '') + `@${an.toLowerCase().replace(/\s/g, '')}.example`;
      if (used.has(email)) email = email.replace('@', `${i}@`); used.add(email);
      const status = pick(['lead', 'lead', 'qualified', 'qualified', 'customer', 'customer', 'churned']);
      const tg = [pick(tags), rnd() > 0.6 ? pick(tags) : null].filter(Boolean);
      contactIds.push(Number(run('INSERT INTO contacts (first_name,last_name,email,phone,title,account_id,status,source,tags,subscribed,owner_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        f, l, email, `+1-555-${int(1000, 9999)}`, pick(titles), aid, status, pick(sources), [...new Set(tg)].join(', '), rnd() > 0.06 ? 1 : 0, pick(uids), daysAgo(int(1, 180))).lastInsertRowid));
    }
    const stages = [['prospecting', 10], ['qualification', 25], ['proposal', 50], ['negotiation', 75], ['won', 100], ['lost', 0]];
    const dealWords = ['Platform license', 'Annual subscription', 'Expansion', 'Pilot program', 'Renewal', 'Integration project', 'Support package', 'Analytics add-on'];
    const dealIds = [];
    for (let i = 0; i < 48; i++) {
      const [aid, an] = pick(accIds); const [stage, prob] = pick([...stages, stages[0], stages[1], stages[2], stages[4], stages[4]]);
      const closed = stage === 'won' || stage === 'lost';
      const created = daysAgo(int(10, 200));
      dealIds.push(Number(run('INSERT INTO deals (name,amount,stage,probability,close_date,account_id,contact_id,owner_id,closed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        `${an} – ${pick(dealWords)}`, int(5, 180) * 1000, stage, prob, closed ? dateOffset(-int(1, 150)) : dateOffset(int(5, 90)), aid, pick(contactIds), pick(uids), closed ? daysAgo(int(1, 150)) : null, created).lastInsertRowid));
    }
    const taskTitles = ['Follow up on proposal', 'Send pricing sheet', 'Schedule demo', 'Prepare contract', 'Check in after onboarding', 'Intro call', 'Share case study', 'Quarterly business review'];
    for (let i = 0; i < 30; i++) {
      run('INSERT INTO tasks (title,due_date,priority,done,owner_id,contact_id,deal_id) VALUES (?,?,?,?,?,?,?)',
        pick(taskTitles), dateOffset(int(-6, 14)), pick(['low', 'medium', 'medium', 'high']), rnd() > 0.7 ? 1 : 0, pick(uids), pick(contactIds), rnd() > 0.5 ? pick(dealIds) : null);
    }
    const notes = ['Great intro call — interested in the analytics module.', 'Sent proposal and pricing; awaiting feedback from procurement.', 'Left voicemail, will retry Thursday.', 'Demo went well, two stakeholders joined.', 'Budget approved for next quarter.', 'Requested a security questionnaire.'];
    for (let i = 0; i < 40; i++) {
      const cid = pick(contactIds);
      run('INSERT INTO activities (type,body,contact_id,account_id,user_id,created_at) VALUES (?,?,?,(SELECT account_id FROM contacts WHERE id=?),?,?)', pick(['note', 'call', 'email', 'meeting']), pick(notes), cid, cid, pick(uids), daysAgo(int(0, 40)));
    }

    // Segments
    const seg = (n, d, f) => Number(run('INSERT INTO segments (name,description,filter,created_by) VALUES (?,?,?,1)', n, d, JSON.stringify(f)).lastInsertRowid);
    const sAll = seg('Newsletter subscribers', 'Everyone tagged newsletter', { match: 'all', rules: [{ field: 'tags', op: 'is', value: 'newsletter' }] });
    const sLeads = seg('Qualified leads', 'Leads and qualified contacts to nurture', { match: 'any', rules: [{ field: 'status', op: 'is', value: 'lead' }, { field: 'status', op: 'is', value: 'qualified' }] });
    const sCust = seg('Customers', 'Active customers', { match: 'all', rules: [{ field: 'status', op: 'is', value: 'customer' }] });
    seg('Software industry decision makers', 'Titles with C-level or VP at software accounts', { match: 'all', rules: [{ field: 'industry', op: 'is', value: 'Software' }, { field: 'title', op: 'contains', value: 'C' }] });

    // Templates
    const tpl = (n, s, b) => run('INSERT INTO templates (name,subject,body_html,created_by) VALUES (?,?,?,1)', n, s, b);
    tpl('Product announcement', 'Introducing what\'s new at Ovantaa, {{first_name|there}}',
      '<h2 style="color:#4f46e5">Big news, {{first_name|there}}!</h2>\n<p>We just shipped a set of features designed for teams like <b>{{company|yours}}</b>.</p>\n<ul><li>Smarter pipeline forecasting</li><li>Campaign analytics in real time</li><li>One-click contact segments</li></ul>\n<p><a href="https://www.ovantaa.example/whats-new" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">See what\'s new</a></p>\n<p>— The Ovantaa team</p>');
    tpl('Event invitation', 'You\'re invited: Ovantaa Customer Summit', '<h2>Join us, {{first_name|friend}}</h2>\n<p>We\'re hosting our annual customer summit and would love to see you there.</p>\n<p><a href="https://www.ovantaa.example/summit">Reserve your seat</a></p>');
    tpl('Re-engagement', 'We miss you, {{first_name|there}}', '<p>Hi {{first_name|there}},</p>\n<p>It\'s been a while! Here\'s what\'s changed since you last logged in.</p>\n<p><a href="https://www.ovantaa.example/reconnect">Take a look</a></p>');

    // Campaigns: one sent with simulated historical engagement, one draft, one scheduled
    const cmp = (n, s, b, seg_, status, sentDays) => Number(run('INSERT INTO campaigns (name,subject,body_html,from_name,from_email,segment_id,status,sent_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,1,?)',
      n, s, b, 'Ovantaa Team', 'hello@ovantaa.example', seg_, status, sentDays ? daysAgo(sentDays) : null, daysAgo((sentDays || 1) + 3)).lastInsertRowid);
    const body = '<h2>Hi {{first_name|there}},</h2><p>Our spring release is here.</p><p><a href="https://www.ovantaa.example/spring">Read the release notes</a> or <a href="https://www.ovantaa.example/demo">book a demo</a>.</p>';
    const sentId = cmp('Spring product launch', 'Spring release: what\'s new for {{company|you}}', body, sLeads, 'sent', 12);
    cmp('Customer summit invite', 'You\'re invited: Ovantaa Customer Summit', '<h2>Join us, {{first_name|friend}}</h2><p><a href="https://www.ovantaa.example/summit">Reserve your seat</a></p>', sCust, 'draft', 0);
    cmp('Monthly newsletter', 'Ovantaa monthly digest', '<p>Hi {{first_name|there}}, here is your monthly digest.</p><p><a href="https://www.ovantaa.example/blog">Read more</a></p>', sAll, 'draft', 0);
    // historical recipients (illustrative demo data)
    const rec = all("SELECT c.id,c.email FROM contacts c WHERE c.status IN ('lead','qualified') AND c.subscribed=1 AND c.email IS NOT NULL");
    for (const c of rec) {
      const opened = rnd() < 0.55, clicked = opened && rnd() < 0.35, unsub = rnd() < 0.02;
      const sent = daysAgo(12);
      const rid = Number(run("INSERT INTO campaign_recipients (campaign_id,contact_id,email,token,status,sent_at,first_open_at,first_click_at,unsubscribed_at,open_count,click_count) VALUES (?,?,?,?,'sent',?,?,?,?,?,?)",
        sentId, c.id, c.email, crypto.randomBytes(12).toString('base64url'), sent, opened ? daysAgo(int(8, 12)) : null, clicked ? daysAgo(int(8, 12)) : null, unsub ? daysAgo(10) : null, opened ? int(1, 4) : 0, clicked ? int(1, 2) : 0).lastInsertRowid);
      if (opened) run("INSERT INTO campaign_events (campaign_id,recipient_id,type,created_at) VALUES (?,?,'open',?)", sentId, rid, daysAgo(int(8, 12)));
      if (clicked) run("INSERT INTO campaign_events (campaign_id,recipient_id,type,url,created_at) VALUES (?,?,'click',?,?)", sentId, rid, rnd() > 0.4 ? 'https://www.ovantaa.example/spring' : 'https://www.ovantaa.example/demo', daysAgo(int(8, 12)));
    }
  });
}

if (process.argv[1]?.endsWith('seed.js')) {
  if (process.argv.includes('--reset')) {
    for (const t of ['campaign_events', 'campaign_recipients', 'campaigns', 'templates', 'segments', 'activities', 'tasks', 'deals', 'contacts', 'accounts', 'audit_log', 'users']) db.exec(`DELETE FROM ${t}`);
  }
  seedIfEmpty();
  console.log(`Seed complete. Login: ${config.adminEmail} / ${config.adminPassword}`);
}
