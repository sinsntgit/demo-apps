import { api, html, raw, setHtml, store, toast, fail, on, $, modal, esc, fmtDateTime } from './core.js';
import { parseCsv, parseXlsx, unzip } from './csv.js';

const ext = (n) => String(n || '').split('.').pop().toLowerCase();
export const sizeText = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
/** How a file can be shown: by MIME type first, extension as a fallback (browsers often upload Office files as octet-stream). */
export function kindOf(f) {
  const m = f.mime || '', e = ext(f.name);
  if (m === 'application/pdf' || e === 'pdf') return 'pdf';
  if (/^image\/(png|jpeg|gif|webp|bmp)$/.test(m) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(e)) return 'image';
  if (m.startsWith('video/') || ['mp4', 'webm'].includes(e)) return 'video';
  if (m.startsWith('audio/') || ['mp3', 'm4a', 'ogg', 'wav'].includes(e)) return 'audio';
  if (['csv', 'tsv'].includes(e) || m === 'text/csv') return 'csv';
  if (e === 'xlsx' || m.includes('spreadsheetml')) return 'xlsx';
  if (e === 'docx' || m.includes('wordprocessingml')) return 'docx';
  if (['pptx', 'ppt', 'doc', 'xls'].includes(e) || /presentationml|ms-powerpoint|msword|ms-excel/.test(m)) return 'office';
  if (m.startsWith('text/') || /json|xml|yaml/.test(m) || ['txt', 'log', 'md', 'json', 'xml', 'yml', 'yaml', 'ini', 'html', 'htm', 'svg'].includes(e)) return 'text';
  return 'other';
}
export const fileIcon = (f) => ({ pdf: '📕', image: '🖼️', video: '🎬', audio: '🎵', csv: '📊', xlsx: '📊', docx: '📝', office: '📑', text: '📄' }[kindOf(f)] || '📎');
const OFFICE = new Set(['xlsx', 'docx', 'office']);
/** External viewers fetch the file from the internet, so they only work when BASE_URL is a public address. */
export function publicBase() {
  try { const u = new URL(store.meta.baseUrl); const h = u.hostname; return !(h === 'localhost' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.endsWith('.local')); } catch { return false; }
}
/** In-app link that opens the record and then this file in the viewer. */
export const fileAppLink = (f) => `${location.origin}${location.pathname}#/${f.entity}/${f.record_id}?file=${f.id}`;

const table = (rows) => {
  const max = 500; const head = rows[0] || []; const body = rows.slice(1, max);
  return html`<div class="tablewrap" style="max-height:70vh;overflow:auto"><table><thead><tr>${head.map((h) => html`<th>${h}</th>`)}</tr></thead><tbody>${body.map((r) => html`<tr>${head.map((_, i) => html`<td>${r[i] ?? ''}</td>`)}</tr>`)}</tbody></table></div>
    ${rows.length > max ? html`<p class="small muted">Showing the first ${max - 1} of ${rows.length - 1} rows — download the file to see everything.</p>` : ''}`;
};
async function docxHtml(buf) {
  const files = await unzip(buf, /^word\/document\.xml$/); const xml = files['word/document.xml']; if (!xml) throw new Error('No document body found');
  const doc = new DOMParser().parseFromString(xml, 'application/xml'); const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const paras = [...doc.getElementsByTagNameNS(W, 'p')].map((p) => {
    const style = p.getElementsByTagNameNS(W, 'pStyle')[0]?.getAttributeNS(W, 'val') || '';
    const text = [...p.getElementsByTagNameNS(W, 't')].map((t) => t.textContent).join('');
    return { text, heading: /^Heading|^Title/i.test(style) };
  }).filter((p) => p.text.trim());
  return html`<div style="max-height:70vh;overflow:auto;background:#fff;color:#111;padding:24px 32px;border-radius:8px;line-height:1.6">${paras.map((p) => (p.heading ? html`<h3 style="margin:14px 0 6px">${p.text}</h3>` : html`<p style="margin:0 0 10px">${p.text}</p>`))}</div>
    <p class="small muted">Text preview — layout, images and tables are simplified. Download or use the Office viewer for the original.</p>`;
}

/** Open the viewer for one file: {id, name, mime, size, ...}. `list` lets the arrows step through sibling files. */
export function viewFile(f, list = [f]) {
  const kind = kindOf(f); const src = `/api/files/${f.id}/view`; const idx = Math.max(0, list.findIndex((x) => x.id === f.id));
  modal({ title: f.name, wide: true, hideFooter: true, body: html`
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
      <span class="small muted">${sizeText(f.size)}${f.uploaded_by_name ? ` · ${f.uploaded_by_name}` : ''}${f.created_at ? ` · ${fmtDateTime(f.created_at)}` : ''}${f.stage ? html` · <span class="badge plain">${(store.meta.stages.find((s) => s.key === f.stage) || {}).label} folder</span>` : ''}</span><span class="grow"></span>
      ${list.length > 1 ? html`<button type="button" class="btn sm" data-act="prev" ${idx === 0 ? raw('disabled') : ''} aria-label="Previous file">‹</button><span class="small muted">${idx + 1} / ${list.length}</span><button type="button" class="btn sm" data-act="next" ${idx === list.length - 1 ? raw('disabled') : ''} aria-label="Next file">›</button>` : ''}
      <a class="btn sm" href="/api/files/${f.id}/download">Download</a>
      ${['pdf', 'image', 'video', 'audio', 'text', 'csv'].includes(kind) ? html`<a class="btn sm" href="${src}" target="_blank" rel="noopener">Open in new tab</a>` : ''}
      ${f.entity ? html`<button type="button" class="btn sm" data-act="copy" title="A link to this file inside Ovantaa (people need to sign in)">Copy link</button>` : ''}
      ${OFFICE.has(kind) ? html`<button type="button" class="btn sm" data-act="office" title="Opens the file in Microsoft's online viewer">Office viewer ↗</button>` : ''}
    </div>
    <div id="vw-body"><div class="empty">Loading preview…</div></div>`,
  onOpen: async (form, close) => {
    const box = $('#vw-body', form);
    on(form, {
      prev: () => { close(); viewFile(list[idx - 1], list); }, next: () => { close(); viewFile(list[idx + 1], list); },
      copy: async () => { try { await navigator.clipboard.writeText(fileAppLink(f)); toast('Link copied', 'ok'); } catch { prompt('Copy this link', fileAppLink(f)); } },
      office: async () => {
        if (!publicBase()) return toast('The Office viewer needs Ovantaa to be reachable on the internet (set BASE_URL to your public https address). Use Download instead.', 'bad');
        const w = window.open('about:blank', '_blank'); // open now so pop-up blockers allow it
        try { const l = await api('POST', `/files/${f.id}/link`); if (w) w.location = `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(l.url)}`; } catch (e) { w?.close(); fail(e); }
      },
    });
    try {
      if (kind === 'pdf') setHtml(box, html`<iframe src="${src}" title="${f.name}" style="width:100%;height:72vh;border:1px solid var(--line);border-radius:8px;background:#fff"></iframe>`);
      else if (kind === 'image') setHtml(box, html`<div style="text-align:center"><img src="${src}" alt="${f.name}" style="max-width:100%;max-height:72vh;border-radius:8px"></div>`);
      else if (kind === 'video') setHtml(box, html`<video src="${src}" controls style="width:100%;max-height:72vh;border-radius:8px"></video>`);
      else if (kind === 'audio') setHtml(box, html`<audio src="${src}" controls style="width:100%"></audio>`);
      else if (kind === 'csv' || kind === 'text') {
        const text = await (await fetch(src)).text();
        if (kind === 'csv') setHtml(box, table(parseCsv(text, ext(f.name) === 'tsv' ? '\t' : undefined)));
        else setHtml(box, html`<pre style="max-height:70vh;overflow:auto;white-space:pre-wrap;background:var(--brand-l);padding:12px;border-radius:8px">${text.slice(0, 200000)}</pre>`);
      } else if (kind === 'xlsx' || kind === 'docx') {
        const buf = await (await fetch(`/api/files/${f.id}/download`)).arrayBuffer();
        setHtml(box, kind === 'xlsx' ? html`${table(await parseXlsx(buf))}<p class="small muted">First sheet, values only. Download or use the Office viewer for formatting and other sheets.</p>` : await docxHtml(buf));
      } else setHtml(box, html`<div class="empty"><div style="font-size:42px">${fileIcon(f)}</div><p>No preview for this type of file.</p><p class="small muted">${OFFICE.has(kind) ? (publicBase() ? 'Use “Office viewer” to see it in your browser, or download it.' : 'Download it to open it on your computer. (The Office viewer works when Ovantaa is reachable on the internet.)') : 'Download it to open it on your computer.'}</p></div>`);
    } catch (e) { setHtml(box, html`<div class="empty"><p>Could not preview this file (${e.message}).</p><a class="btn" href="/api/files/${f.id}/download">Download</a></div>`); }
  } });
}
/** Open the file named in the URL (…?file=ID) once a record page is shown. */
export async function openFileFromUrl(files) {
  const m = location.hash.match(/[?&]file=(\d+)/); if (!m) return;
  const f = files.find((x) => String(x.id) === m[1]); if (f) viewFile(f, files);
  history.replaceState(null, '', location.hash.replace(/[?&]file=\d+/, '').replace(/\?$/, '') || '#/');
}
export { esc };
