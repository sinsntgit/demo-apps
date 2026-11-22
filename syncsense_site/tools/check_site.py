"""Site checks: broken internal links and anchors, JSON-LD validity, banned words, em-dash overuse.
Usage: python3 tools/check_site.py public
"""
import re,sys,json,pathlib,html
P=pathlib.Path(sys.argv[1]); pages=sorted(P.rglob("*.html")); bad=[]; ids={}
for f in pages:
    s=f.read_text(); ids[f]=set(re.findall(r'id="([^"]+)"',s))
def target(href):
    path=href.split('#')[0].split('?')[0]
    if path=='': return None
    t=P/path.lstrip('/')
    if path.endswith('/'): t=t/'index.html'
    return t
for f in pages:
    s=f.read_text()
    for h in re.findall(r'(?:href|src)="([^"]+)"',s):
        if h.startswith(('http','mailto:','tel:','#')) or h.startswith('//'): continue
        t=target(h)
        if t and not t.exists(): bad.append((str(f.relative_to(P)),h))
        if '#' in h and t and t.exists():
            frag=h.split('#')[1]
            if frag and frag not in ids.get(t,set()): bad.append((str(f.relative_to(P)),h+' (anchor)'))
    for m in re.findall(r'<script type="application/ld\+json">(.*?)</script>',s,re.S):
        try:
            d=json.loads(m.replace('<\\/','</'))
            for n in d['@graph']:
                assert '@type' in n
        except Exception as e: bad.append((str(f.relative_to(P)),'JSON-LD '+str(e)))
    body=re.sub(r'<(script|style)[^>]*>.*?</\1>','',s,flags=re.S); text=html.unescape(re.sub('<[^>]+>',' ',body))
    for w in ['leverage','synergy','best-in-class','cutting-edge','unlock','revolutioniz','revolutionis','leading provider',"It's not","It’s not",'The result?','seamless','game-chang','empower']:
        if w.lower() in text.lower(): bad.append((str(f.relative_to(P)),'banned word: '+w))
    em=text.count('—')
    if em>2: bad.append((str(f.relative_to(P)),f'{em} em dashes'))
print(len(pages),'html files'); print('\n'.join(map(str,bad)) or 'NO ISSUES')
