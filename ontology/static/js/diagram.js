// Draws a diagram spec (app/layout.py) as SVG: zoom, drag to pan, clickable boxes and links.
// The server draws the same spec with matplotlib for PDF and PowerPoint (app/render.py) - change both.
import { h } from './core.js';

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (v != null && v !== false) el.setAttribute(k, v); }
  for (const kid of kids.flat()) { if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
  return el;
}
/** Point where the line from the centre of box a towards (bx, by) leaves the box. */
function clip(a, bx, by) {
  const dx = bx - a.x, dy = by - a.y;
  if (!dx && !dy) return [a.x, a.y];
  const t = Math.min(dx ? (a.w / 2) / Math.abs(dx) : 9e9, dy ? (a.h / 2) / Math.abs(dy) : 9e9);
  return [a.x + dx * t, a.y + dy * t];
}
let uid = 0;

/** opts: onNode(node), onEdge(edge), selected (node id), maxHeight (px), legend (default true),
 *  onToggle(node) - show a +/− on hierarchy boxes that have subclasses, to expand or collapse that branch,
 *  onExpandAll() / onCollapseAll() - toolbar buttons for the whole tree,
 *  maxTarget - the element that "Maximise" fills the window with (default: the diagram itself; pass a
 *              surrounding element to keep side panels visible and to survive a redraw),
 *  keep - an object the caller keeps between redraws; zoom and scroll position are remembered in it. */
export function diagram(spec, opts = {}) {
  const id = 'dg' + (++uid);
  const W = Math.max(spec.width, 120), H = Math.max(spec.height, 60);
  const nodes = Object.fromEntries(spec.nodes.map(n => [n.id, n]));
  const marker = (name, cls) => s('marker', { id: `${id}-${name}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
    s('path', { d: 'M0,0 L10,5 L0,10 z', class: cls }));
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'dg-svg', role: 'img', 'aria-label': 'Ontology diagram' },
    s('defs', {}, marker('rel', 'dg-m-rel'), marker('gap', 'dg-m-gap'), marker('sub', 'dg-m-sub')));
  const gEdges = s('g', {}), gLabels = s('g', {}), gNodes = s('g', {});
  svg.append(gEdges, gLabels, gNodes);

  for (const e of spec.edges) {
    let a = nodes[e.a], b = nodes[e.b];
    if (spec.kind === 'hierarchy') {
      const x1 = a.x + a.w / 2, x2 = b.x - b.w / 2, mid = x1 + 18;
      gEdges.append(s('path', { d: `M${x1},${a.y} H${mid} V${b.y} H${x2}`, class: 'dg-tree' }));
      continue;
    }
    const gap = e.style.startsWith('gap'), sub = e.style.endsWith('sub');
    if (sub) [a, b] = [b, a];                                  // "is a kind of": the arrow points at the parent
    const kind = gap ? 'gap' : sub ? 'sub' : 'rel';
    let d, lx, ly;
    if (e.cx != null) {
      const cx = 2 * e.cx - (a.x + b.x) / 2, cy = e.cy;
      const p1 = clip(a, cx, cy), p2 = clip(b, cx, cy);
      d = `M${p1[0]},${p1[1]} Q${cx},${cy} ${p2[0]},${p2[1]}`;
      lx = (p1[0] + 2 * cx + p2[0]) / 4; ly = (p1[1] + 2 * cy + p2[1]) / 4;
    } else {
      const p1 = clip(a, b.x, b.y), p2 = clip(b, a.x, a.y);
      d = `M${p1[0]},${p1[1]} L${p2[0]},${p2[1]}`;
      lx = (p1[0] + p2[0]) / 2; ly = (p1[1] + p2[1]) / 2;
    }
    const path = s('path', { d, class: `dg-edge dg-${kind}${gap || sub ? ' dashed' : ''}`, 'marker-end': `url(#${id}-${kind})` });
    gEdges.append(path);
    if (opts.onEdge && e.style === 'rel') {
      const hit = s('path', { d, class: 'dg-hit' }, s('title', {}, 'Click to edit this relationship'));
      hit.addEventListener('click', ev => { ev.stopPropagation(); opts.onEdge(e); });
      gEdges.append(hit);
    }
    if (e.label) {
      const t = s('text', { x: lx, y: ly + 3.5, class: `dg-elabel dg-t-${kind}${opts.onEdge && e.style === 'rel' ? ' click' : ''}`, 'text-anchor': 'middle' }, e.label);
      if (opts.onEdge && e.style === 'rel') t.addEventListener('click', ev => { ev.stopPropagation(); opts.onEdge(e); });
      gLabels.append(t);
    }
  }
  for (const n of spec.nodes) {
    const cls = `dg-node s-${n.style}${n.group >= 0 && n.style !== 'gap' && n.style !== 'dim' ? ' g' + (n.group % 9) : ''}${opts.selected === n.id ? ' sel' : ''}${opts.onNode && n.style !== 'root' ? ' click' : ''}`;
    const top = n.attrs.length ? n.y - n.h / 2 + 15 : n.y;
    const g = s('g', { class: cls, 'data-id': n.id },
      s('rect', { x: n.x - n.w / 2, y: n.y - n.h / 2, width: n.w, height: n.h, rx: 7 }),
      n.sub ? s('text', { x: n.x - n.w / 2 + 10, y: top + 4, class: 'dg-label' }, n.label) : s('text', { x: n.x, y: top + 4, class: 'dg-label', 'text-anchor': 'middle' }, n.label),
      n.sub ? s('text', { x: n.x + n.w / 2 - 9, y: top + 3.5, class: 'dg-sub', 'text-anchor': 'end' }, n.sub) : null,
      n.attrs.map((a, i) => s('text', { x: n.x - n.w / 2 + 10, y: top + 20 + i * 15, class: 'dg-attr' + (a.startsWith('+') ? ' gap' : '') }, a)));
    if (opts.onNode && n.style !== 'root') g.addEventListener('click', ev => { ev.stopPropagation(); opts.onNode(n); });
    gNodes.append(g);
    if (spec.kind === 'hierarchy' && n.kids && opts.onToggle) {           // expand / collapse this branch
      const tx = n.x + n.w / 2 + 11, title = n.collapsed ? `Expand: show the ${n.sub.replace(/^\+(\d+) more$/, '$1')} classes under ${n.label}` : `Collapse: hide the subclasses of ${n.label}`;
      const tg = s('g', { class: 'dg-toggle', 'data-id': n.id, role: 'button', 'aria-label': title },
        s('title', {}, title), s('circle', { cx: tx, cy: n.y, r: 8 }),
        s('path', { d: n.collapsed ? `M${tx - 4},${n.y} H${tx + 4} M${tx},${n.y - 4} V${n.y + 4}` : `M${tx - 4},${n.y} H${tx + 4}` }));
      tg.addEventListener('click', ev => { ev.stopPropagation(); opts.onToggle(n); });
      gNodes.append(tg);
    }
  }

  // zoom and pan
  const keep = opts.keep || {};
  const scroller = h('div', { class: 'dg-scroll', style: opts.maxHeight ? `max-height:${opts.maxHeight}px` : null,
    onscroll: () => { keep.left = scroller.scrollLeft; keep.top = scroller.scrollTop; } }, svg);
  let zoom = 1;
  const apply = () => { svg.style.width = W * zoom + 'px'; svg.style.height = H * zoom + 'px'; pct.textContent = Math.round(zoom * 100) + '%'; };
  const set = z => { zoom = Math.max(0.25, Math.min(2.5, z)); keep.zoom = zoom; apply(); };
  const fit = () => { const w = scroller.clientWidth - 4; set(w > 0 ? Math.min(1, Math.max(0.3, w / W)) : 1); };
  const pct = h('span', { class: 'small dim', style: 'min-width:38px;text-align:center' });
  // maximise: the target fills the window; Esc or the button restores it
  const target = () => opts.maxTarget || el;
  const isMax = () => target().classList.contains('dg-max');
  const label = () => { maxBtn.textContent = isMax() ? '⤡ Restore' : '⤢ Maximise'; maxBtn.title = isMax() ? 'Back to normal size (Esc)' : 'Fill the window with the diagram'; };
  const setMax = on => {
    target().classList.toggle('dg-max', on);
    document.body.classList.toggle('dg-max-open', !!document.querySelector('.dg-max'));
    label(); requestAnimationFrame(fit);
  };
  const maxBtn = h('button', { class: 'btn sm', onclick: () => setMax(!isMax()) });
  const onKey = e => {
    if (!el.isConnected) return window.removeEventListener('keydown', onKey, true);
    if (e.key === 'Escape' && isMax() && !document.querySelector('.overlay .modal:not(:has(.dg-max))')) { e.stopPropagation(); e.preventDefault(); setMax(false); }
  };
  window.addEventListener('keydown', onKey, true);       // capture: closes the maximised view before a dialog's Esc handler runs
  const bar = h('div', { class: 'dg-bar' },
    h('button', { class: 'btn sm', title: 'Zoom out', onclick: () => set(zoom / 1.2) }, '−'), pct,
    h('button', { class: 'btn sm', title: 'Zoom in', onclick: () => set(zoom * 1.2) }, '+'),
    h('button', { class: 'btn sm', title: 'Fit to width', onclick: fit }, 'Fit'),
    h('button', { class: 'btn sm', title: 'Actual size', onclick: () => set(1) }, '100%'),
    opts.onExpandAll ? h('span', { class: 'dg-sep' }) : null,
    opts.onExpandAll ? h('button', { class: 'btn sm', title: 'Show every class', onclick: () => opts.onExpandAll() }, '⊞ Expand all') : null,
    opts.onCollapseAll ? h('button', { class: 'btn sm', title: 'Show only the top-level classes', onclick: () => opts.onCollapseAll() }, '⊟ Collapse all') : null,
    spec.kind === 'hierarchy' && opts.onToggle ? h('span', { class: 'small dim dg-hint' }, '⊕ / ⊖ beside a box: expand / collapse') : null,
    h('span', { class: 'spacer' }), maxBtn);
  scroller.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); set(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); } }, { passive: false });
  let drag = null;
  scroller.addEventListener('mousedown', e => { if (e.target.closest('.click, .dg-hit')) return; drag = { x: e.clientX, y: e.clientY, l: scroller.scrollLeft, t: scroller.scrollTop }; scroller.classList.add('grabbing'); });
  window.addEventListener('mousemove', e => { if (drag) { scroller.scrollLeft = drag.l - (e.clientX - drag.x); scroller.scrollTop = drag.t - (e.clientY - drag.y); } });
  window.addEventListener('mouseup', () => { drag = null; scroller.classList.remove('grabbing'); });
  const legend = opts.legend === false || !spec.legend?.length ? null :
    h('div', { class: 'dg-legend' }, spec.legend.map(l => h('span', {}, h('i', { class: 'g' + (l.group % 9) }), l.name)),
      spec.nodes.some(n => n.style === 'gap') ? h('span', {}, h('i', { class: 'gapbox' }), 'Proposed addition (not in the ontology yet)') : null,
      spec.nodes.some(n => n.style === 'hit') ? h('span', {}, h('i', { class: 'hitbox' }), spec.kind === 'relations' && opts.hitLabel ? opts.hitLabel : 'Used by this use case') : null,
      spec.nodes.some(n => n.style === 'dim') ? h('span', {}, h('i', { class: 'dimbox' }), 'Other module') : null);
  const el = h('div', { class: 'dg' }, bar, scroller, legend);
  el.fit = fit;
  label();
  if (keep.zoom) {                    // a redraw (expand / collapse) keeps the zoom and the part of the picture in view
    set(keep.zoom);
    requestAnimationFrame(() => { scroller.scrollLeft = keep.left || 0; scroller.scrollTop = keep.top || 0; });
  } else requestAnimationFrame(fit);
  apply();
  return el;
}
