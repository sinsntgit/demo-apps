// Sign-in, 2FA challenge, forced first-run setup (password change / 2FA enrolment).
import { h, fill, api, busy, field, state, toast } from './core.js';

const shell = (...kids) => h('div', { class: 'auth' }, h('div', { class: 'card stack' },
  h('div', { class: 'brand' }, h('i', {}, '▮▮'), state.me?.app_name || 'AskData'), ...kids));

export function loginView(onDone) {
  const root = h('div', {});
  const err = h('div', { class: 'banner bad hidden' });
  const show = e => { err.textContent = e.message; err.classList.remove('hidden'); };

  function passwordStep() {
    const email = h('input', { type: 'email', autocomplete: 'username', required: true });
    const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const btn = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%;justify-content:center' }, 'Sign in');
    const form = h('form', { class: 'stack', onsubmit: async e => {
      e.preventDefault(); btn.disabled = true; err.classList.add('hidden');
      try {
        const r = await api('POST', '/api/auth/login', { email: email.value, password: pw.value });
        r.step === 'mfa' ? mfaStep() : onDone();
      } catch (ex) { show(ex); } finally { btn.disabled = false; }
    } }, h('p', { class: 'muted' }, 'Sign in to ask questions of your data.'), err, field('Email', email), field('Password', pw), btn);
    fill(root, shell(form));
    email.focus();
  }

  function mfaStep() {
    err.classList.add('hidden');
    const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456', required: true });
    const btn = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%;justify-content:center' }, 'Verify');
    const form = h('form', { class: 'stack', onsubmit: async e => {
      e.preventDefault(); btn.disabled = true; err.classList.add('hidden');
      try { await api('POST', '/api/auth/mfa', { code: code.value }); onDone(); }
      catch (ex) { show(ex); code.select(); } finally { btn.disabled = false; }
    } }, h('h2', {}, 'Two-factor authentication'), h('p', { class: 'muted' }, 'Enter the 6-digit code from your authenticator app, or one of your recovery codes.'),
      err, field('Code', code), btn, h('button', { class: 'btn ghost', type: 'button', onclick: passwordStep }, '← Back'));
    fill(root, shell(form));
    code.focus();
  }
  passwordStep();
  return root;
}

export function passwordForm(onDone, intro) {
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const nw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 });
  const again = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Change password');
  return h('form', { class: 'stack', onsubmit: e => {
    e.preventDefault();
    if (nw.value !== again.value) return toast('The two new passwords do not match.', true);
    busy(btn, async () => { await api('POST', '/api/auth/change-password', { current: cur.value, new: nw.value }); toast('Password changed. Other sessions were signed out.'); onDone(); });
  } }, intro ? h('p', { class: 'muted' }, intro) : null, field('Current password', cur),
    field('New password', nw, 'at least 10 characters with upper, lower case and a digit'), field('Repeat new password', again), h('div', {}, btn));
}

export function recoveryCodes(codes, onDone) {
  return h('div', { class: 'stack' }, h('div', { class: 'banner warn' }, 'Save these recovery codes somewhere safe. Each works once if you lose your authenticator. They will not be shown again.'),
    h('div', { class: 'codes' }, codes.map(c => h('div', {}, c))),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(codes.join('\n')).then(() => toast('Copied')) }, 'Copy'),
      h('button', { class: 'btn primary', onclick: onDone }, 'I have saved them')));
}

export function twoFactorEnrol(onDone) {
  const root = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Preparing…'));
  api('POST', '/api/auth/2fa/setup').then(r => {
    const code = h('input', { type: 'text', inputmode: 'numeric', placeholder: '123456', autocomplete: 'one-time-code', required: true });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Turn on 2FA');
    fill(root, 
      h('p', { class: 'muted' }, 'Scan this QR code with an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password, Authy…), then enter the 6-digit code it shows.'),
      h('div', { class: 'qr', html: r.qr_svg }),
      h('p', { class: 'small dim', style: 'text-align:center' }, 'Or enter this key manually: ', h('span', { class: 'mono' }, r.secret)),
      h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); busy(btn, async () => {
        const out = await api('POST', '/api/auth/2fa/enable', { code: code.value });
        fill(root, recoveryCodes(out.recovery_codes, onDone));
      }); } }, field('Code from the app', code), h('div', {}, btn)));
  }).catch(e => fill(root, h('div', { class: 'banner bad' }, e.message)));
  return root;
}

/** Blocking screen shown while the account still has required setup steps. */
export function setupView(onDone) {
  const req = state.me.requirements;
  const logout = h('button', { class: 'btn ghost', onclick: async () => { await api('POST', '/api/auth/logout'); location.reload(); } }, 'Sign out');
  if (req.includes('change_password'))
    return shell(h('h2', {}, 'Choose a new password'), passwordForm(onDone, 'Your password was set by an administrator. Choose your own before continuing.'), logout);
  return shell(h('h2', {}, 'Set up two-factor authentication'), h('p', { class: 'small muted' }, 'Your organisation requires 2FA for every account.'), twoFactorEnrol(onDone), logout);
}
