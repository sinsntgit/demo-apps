// My account: password and two-factor authentication.
import { h, fill, api, busy, toast, modal, field, state } from './core.js';
import { passwordForm, twoFactorEnrol, recoveryCodes } from './auth.js';

export async function accountView(root, reboot) {
  const me = state.me = await api('GET', '/api/auth/me');
  const twofa = h('div', { class: 'stack' });
  const refresh = () => accountView(root, reboot);
  if (me.totp_enabled) {
    const regen = () => { const code = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'Current 6-digit code' });
      const box = h('div', { class: 'stack' }, field('Authenticator code', code), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => { const r = await api('POST', '/api/auth/2fa/recovery-codes', { code: code.value }); fill(box, recoveryCodes(r.recovery_codes, () => { close(); refresh(); })); }) }, 'Generate new codes'));
      const close = modal('New recovery codes', box); };
    const disable = () => { const pw = h('input', { type: 'password', autocomplete: 'current-password' }), code = h('input', { type: 'text', inputmode: 'numeric' });
      modal('Turn off two-factor authentication', h('div', { class: 'stack' }, field('Password', pw), field('Authenticator code', code)), { actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', { class: 'btn danger', onclick: e => busy(e.target, async () => { await api('POST', '/api/auth/2fa/disable', { password: pw.value, code: code.value }); close(); toast('2FA turned off'); refresh(); }) }, 'Turn off')] }); };
    twofa.append(h('div', { class: 'row' }, h('span', { class: 'badge good' }, '✓ Enabled'), h('span', { class: 'small muted' }, `${me.recovery_codes_left} recovery code(s) left`)),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: regen }, 'New recovery codes'), me.enforce_2fa ? h('span', { class: 'small dim' }, 'Required by your organisation.') : h('button', { class: 'btn danger', onclick: disable }, 'Turn off 2FA')));
  } else {
    const start = h('button', { class: 'btn primary', onclick: () => fill(twofa, twoFactorEnrol(refresh)) }, 'Set up 2FA');
    twofa.append(h('p', { class: 'muted' }, 'Add a second step at sign-in using an authenticator app. Strongly recommended for anyone who can query business data.'), h('div', {}, start));
  }
  fill(root, h('div', { class: 'page', style: 'max-width:640px' }, h('div', { class: 'page-head' }, h('h1', {}, 'My account')),
    h('div', { class: 'stack' }, h('div', { class: 'card' }, h('b', {}, me.name || me.email), h('div', { class: 'muted' }, `${me.email} · ${me.role}`)),
      h('div', { class: 'card stack' }, h('h2', {}, 'Two-factor authentication'), twofa),
      h('div', { class: 'card stack' }, h('h2', {}, 'Password'), passwordForm(() => reboot())))));
}
