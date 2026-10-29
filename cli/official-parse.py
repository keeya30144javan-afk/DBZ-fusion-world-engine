"""Parse official card detail pages (det/*.html) into official.json."""
import re, sys, json, os, html
d = sys.argv[1]; out = {}
def clean(x):
    x = re.sub(r'<br\s*/?>', '\n', x)
    x = re.sub(r'<span class="costIcon[^"]*">([^<]*)</span>', r'(\1)', x)
    x = re.sub(r'<[^>]+>', '', x)
    return '\n'.join(l.strip() for l in html.unescape(x).strip().split('\n'))
def cell(t, h, side=None):
    m = re.search(r'<h6>' + re.escape(h) + r'</h6>(.*?)(?=<h6>|<div class="cardDataRow|<div class="informationCol|</article)', t, re.S)
    if not m: return None
    blk = m.group(1)
    if side:
        s = re.search(r'<div class="data[^"]*is-' + side + r'[^"]*">(.*?)</div>', blk, re.S)
        if s: return clean(s.group(1))
        if 'is-front' in blk: return None
    s = re.search(r'<div class="data[^"]*">(.*?)</div>', blk, re.S)
    return clean(s.group(1)) if s else None
def num(x):
    try: return int(x)
    except: return None
for f in sorted(os.listdir(d)):
    t = open(os.path.join(d, f), encoding='utf8').read()
    cid = f[:-5]
    name_f = re.search(r'cardName is-front">([^<]*)', t) or re.search(r'class="cardName[^"]*">([^<]*)', t)
    name_b = re.search(r'cardName is-back">([^<]*)', t)
    colors = re.findall(r'class="colValue" data-color="([^"]+)"', t)
    sm = re.search(r'<h6>Specified cost</h6>(.*?)</div>\s*</div>', t, re.S)
    spec = {}
    for c in re.findall(r'costIcon costIcon-([a-z]+)', sm.group(1) if sm else ''):
        c = c.capitalize(); spec[c] = spec.get(c, 0) + 1
    rec = {
        'id': cid, 'name': html.unescape(name_f.group(1).strip()) if name_f else None,
        'type': cell(t, 'Card type'), 'colors': colors, 'cost': num(cell(t, 'Cost') or ''),
        'specified': spec, 'power': num(cell(t, 'Power', 'front') or ''), 'comboPower': num(cell(t, 'Combo power') or ''),
        'traits': [x for x in (cell(t, 'Special Traits', 'front') or '').split('/') if x and x != '-'],
        'text': cell(t, 'Skills', 'front') or '', 'rarity': (re.search(r'class="rarity">([^<]*)', t) or [None, None])[1],
    }
    if 'is-back' in t and rec['type'] == 'LEADER':
        rec['back'] = {'name': html.unescape(name_b.group(1).strip()) if name_b else rec['name'], 'power': num(cell(t, 'Power', 'back') or ''), 'text': cell(t, 'Skills', 'back') or ''}
    qa = []
    for li in re.findall(r'<li class="cardQA_listItem">(.*?)</li>', t, re.S):
        texts = re.findall(r'<p class="cardQA_text">(.*?)</p>', li, re.S)
        n = re.search(r'cardQA_number">([^<]*)', li)
        rel = re.findall(r'cardQA_relatedItem"[^>]*q=([A-Z0-9-]+)', li)
        if len(texts) >= 2: qa.append({'n': n.group(1) if n else '', 'q': clean(texts[0]), 'a': clean(texts[1]), 'related': rel})
    if qa: rec['qa'] = qa
    out[cid] = rec
json.dump(out, open(sys.argv[2], 'w'), indent=0, ensure_ascii=False)
print(len(out), 'cards', sum(len(r.get('qa', [])) for r in out.values()), 'Q&A')
