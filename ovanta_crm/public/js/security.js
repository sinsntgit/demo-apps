import { api, html, raw, setHtml, store, toast, fail, on, $, modal, confirmBox, fmtDateTime, field } from './core.js';

/** Step-by-step authenticator set-up. `done()` is called once two-factor is switched on. */
export async function twofaSetup(root, done) {
  const s = await api('POST', '/2fa/setup');
  setHtml(root, html`<div class="twofa"><ol class="small" style="padding-left:18px;margin:0 0 10px"><li>Install an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password…).</li><li>Scan the code, or type the key in by hand.</li><li>Enter the 6-digit code it shows.</li></ol>
    <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">${s.qr ? html`<img src="${s.qr}" width="180" height="180" alt="QR code for the authenticator app" style="background:#fff;border-radius:8px;padding:6px">` : ''}
    <div><div class="muted small">Key (type this if you cannot scan)</div><div class="mono" style="font-size:15px;letter-spacing:1px;word-break:break-all">${s.secret.match(/.{1,4}/g).join(' ')}</div></div></div>
    <form id="tf-enable" style="margin-top:12px;display:flex;gap:8px;align-items:end;flex-wrap:wrap"><label>6-digit code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required style="width:140px"></label><button class="btn primary">Turn on</button></form><div class="err" hidden></div></div>`);
  $('#tf-enable', root).addEventListener('submit', async (e) => {
    e.preventDefault(); const err = $('.err', root);
    try { const r = await api('POST', '/2fa/enable', { code: e.currentTarget.code.value }); store.user.twofa_enabled = true; if (store.user.limited) store.user.limited = false; showRecoveryCodes(r.recovery_codes, done); }
    catch (x) { err.textContent = x.message; err.hidden = false; }
  });
}

export function showRecoveryCodes(codes, after) {
  modal({ title: 'Save your recovery codes', hideFooter: true, wide: false, body: html`<p>If you lose your phone, each of these one-time codes lets you sign in once. <b>They will not be shown again</b> — store them somewhere safe (a password manager or printed).</p>
    <div class="mono" style="columns:2;font-size:15px;line-height:1.9;background:var(--bg-soft,rgba(127,127,127,.1));border-radius:8px;padding:10px 14px">${codes.map((c) => html`<div>${c}</div>`)}</div>
    <div style="display:flex;gap:8px;margin-top:12px"><button type="button" class="btn" data-act="copy">Copy</button><button type="button" class="btn" data-act="dl">Download .txt</button><span class="grow"></span><button type="button" class="btn primary" data-close>I have saved them</button></div>`,
    onOpen: (form, close) => { on(form, { copy: async () => { await navigator.clipboard?.writeText(codes.join('\n')); toast('Copied', 'ok'); }, dl: () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([`Ovantaa CRM recovery codes\n\n${codes.join('\n')}\n`], { type: 'text/plain' })); a.download = 'ovantaa-recovery-codes.txt'; a.click(); } }); const ov = form.closest('.overlay'); new MutationObserver((_, o) => { if (!document.body.contains(ov)) { o.disconnect(); after?.(); } }).observe(document.body, { childList: true }); } });
}

/** Whole-page prompt for people whose company requires two-factor and who have not set it up yet. */
export function forcedSetup(app, onDone, onLogout) {
  setHtml(app, html`<div class="login"><div class="box" style="max-width:520px"><div class="brand"><span class="logo"><i></i></span>Ovantaa CRM</div><h2>Set up two-factor sign-in</h2>
    <p class="muted">Your company requires an authenticator app for every sign-in. This takes a minute.</p><div id="tf-root"></div><p style="margin-top:14px"><button class="btn sm" id="tf-out">Sign out</button></p></div></div>`);
  twofaSetup($('#tf-root', app), onDone).catch(fail); $('#tf-out', app).addEventListener('click', onLogout);
}

/** "Security" card for the Settings page: 2FA + signed-in devices (+ company policy for admins). */
export async function securityCard(root, { admin }) {
  const [st, sessions, policy] = await Promise.all([api('GET', '/2fa/status'), api('GET', '/sessions'), admin ? api('GET', '/settings/security') : null]);
  const draw = () => securityCard(root, { admin });
  setHtml(root, html`<div class="card"><div class="hd"><h2>Security</h2></div><div class="bd">
    <h3 style="margin-top:0">Two-factor authentication ${st.enabled ? html`<span class="badge sent">on</span>` : html`<span class="badge draft">off</span>`}</h3>
    ${st.enabled ? html`<p class="small muted">Signing in needs a code from your authenticator app. Recovery codes left: <b>${st.recovery_left}</b>.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="regen">New recovery codes</button>${st.required ? '' : html`<button class="btn danger" data-act="off">Turn off</button>`}</div>${st.required ? html`<p class="small muted">Your company requires two-factor, so it cannot be turned off.</p>` : ''}`
    : html`<p class="small muted">Adds a second step to sign-in so a stolen password alone is not enough.</p><div id="tf-box"><button class="btn primary" data-act="on">Set up</button></div>`}
    <hr style="border:0;border-top:1px solid var(--line);margin:14px 0"><h3>Signed-in devices</h3>
    <div class="tablewrap"><table><tbody>${sessions.map((s) => html`<tr><td>${s.current ? html`<b>This device</b>` : 'Another device'}<div class="small muted">${(s.user_agent || '').slice(0, 70) || 'unknown browser'} · ${s.ip || ''}</div></td><td class="small">Last active<br>${fmtDateTime(s.last_seen_at)}</td><td>${s.current ? '' : html`<button class="btn sm danger" data-act="kill" data-id="${s.id}">Sign out</button>`}</td></tr>`)}</tbody></table></div>
    ${sessions.length > 1 ? html`<button class="btn sm" data-act="killall" style="margin-top:8px">Sign out all other devices</button>` : ''}
    ${admin ? html`<hr style="border:0;border-top:1px solid var(--line);margin:14px 0"><h3>Company policy</h3><label style="max-width:360px">Require two-factor sign-in for<select id="pol">${[['off', 'Nobody (optional for everyone)'], ['admins', 'Administrators'], ['all', 'Everyone']].map(([v, l]) => html`<option value="${v}" ${v === policy.require_2fa ? raw('selected') : ''}>${l}</option>`)}</select></label>
      <p class="small muted">${policy.users_with_2fa} of ${policy.users_total} active users have it on. People who are required but have not set it up are asked to do so at their next sign-in. If someone loses their phone, reset their two-factor from <a href="#/team">Team &amp; roles</a>.</p>` : ''}</div></div>`);
  on(root, {
    on: async () => twofaSetup($('#tf-box', root), draw),
    off: () => modal({ title: 'Turn off two-factor', submitLabel: 'Turn off', danger: true, body: html`${field({ name: 'password', label: 'Confirm with your password', type: 'password', required: true })}`, onSubmit: async (f) => { await api('POST', '/2fa/disable', { password: f.password.value }); store.user.twofa_enabled = false; toast('Two-factor turned off', 'ok'); draw(); } }),
    regen: () => modal({ title: 'New recovery codes', submitLabel: 'Generate', body: html`<p class="small muted">This invalidates your old codes.</p>${field({ name: 'password', label: 'Confirm with your password', type: 'password', required: true })}`, onSubmit: async (f) => { const r = await api('POST', '/2fa/recovery-codes', { password: f.password.value }); setTimeout(() => showRecoveryCodes(r.recovery_codes, draw), 50); } }),
    kill: async (el) => { await api('DELETE', `/sessions/${el.dataset.id}`); toast('Signed out', 'ok'); draw(); },
    killall: async () => { await api('POST', '/sessions/revoke-others'); toast('Signed out everywhere else', 'ok'); draw(); },
  });
  if (admin) $('#pol', root).addEventListener('change', async (e) => { try { await api('PUT', '/settings/security', { require_2fa: e.target.value }); toast('Policy saved', 'ok'); draw(); } catch (x) { fail(x); } });
}
