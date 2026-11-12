// Mudviejų ratas — pranešimų siuntėjas (Cloudflare Worker, nemokamas planas).
// Reikia: KV binding pavadinimu KV; cron trigeris "0 * * * *" (kas valandą; priminimas siunčiamas 19:00 Vilniaus laiku).
// Jokių slaptų raktų įvesti nereikia: VAPID raktų pora sugeneruojama pirmą kartą ir laikoma KV.
const FS = 'https://firestore.googleapis.com/v1/projects/mudvieju-ratas/databases/(default)/documents';
const API_KEY = 'AIzaSyB-6u2upI9AeED4Xqa0oGJxYvm0QVPPr34'; // viešas Firebase web raktas
const ORIGIN = 'https://domas-stankevicius.github.io';
const SITE = 'https://domas-stankevicius.github.io/ratas/';
const ROOM_RE = /^[A-Za-z0-9-]{12,40}$/;
const REMIND_HOUR = 19;

const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
const vilnius = (o) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Vilnius', ...o });

async function vapid(env) {
  let j = await env.KV.get('vapid', 'json');
  if (!j) {
    const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    j = { priv: await crypto.subtle.exportKey('jwk', k.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', k.publicKey)) };
    await env.KV.put('vapid', JSON.stringify(j));
  }
  return j;
}
async function jwt(aud, j) {
  const h = enc({ typ: 'JWT', alg: 'ES256' }), p = enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SITE });
  const key = await crypto.subtle.importKey('jwk', { ...j.priv, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(h + '.' + p));
  return h + '.' + p + '.' + b64u(sig);
}
const fsGet = async path => { const r = await fetch(`${FS}/${path}?key=${API_KEY}`); return r.ok ? r.json() : null; };
const str = (doc, f) => doc && doc.fields && doc.fields[f] && doc.fields[f].stringValue;
const clip = (s, n) => String(s || '').slice(0, n);

async function send(env, room, to, title, body) {
  // 1) laiškas gavėjui: service worker jį perskaitys, kai ateis tuščias push
  await fetch(`${FS}/rooms/${room}/inbox/${to}?key=${API_KEY}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { title: { stringValue: clip(title, 80) }, body: { stringValue: clip(body, 160) }, ts: { integerValue: String(Date.now()) } } })
  });
  // 2) push be turinio
  const sub = await fsGet(`rooms/${room}/push/${to}`), endpoint = str(sub, 'endpoint');
  if (!endpoint || !/^https:\/\//.test(endpoint)) return 'no-subscription';
  const j = await vapid(env), t = await jwt(new URL(endpoint).origin, j);
  const r = await fetch(endpoint, { method: 'POST', headers: { Authorization: `vapid t=${t}, k=${j.pub}`, TTL: '86400', Urgency: 'high', 'Content-Length': '0' } });
  if (r.status === 404 || r.status === 410) await fetch(`${FS}/rooms/${room}/push/${to}?key=${API_KEY}`, { method: 'DELETE' });
  return r.status;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const u = new URL(req.url);
    try {
      if (u.pathname === '/vapid') return json({ key: (await vapid(env)).pub });
      if (req.method !== 'POST') return json({ ok: true, app: 'ratas-push' });
      const b = await req.json().catch(() => ({}));
      if (!ROOM_RE.test(b.room || '')) return json({ error: 'room' }, 400);
      if (u.pathname === '/register') { await env.KV.put('room:' + b.room, '1'); return json({ ok: true }); }
      if (u.pathname === '/notify') {
        if (!/^[ab]$/.test(b.to || '')) return json({ error: 'to' }, 400);
        const last = Number(await env.KV.get('rate:' + b.room) || 0);
        if (Date.now() - last < 3000) return json({ error: 'slow down' }, 429);
        await env.KV.put('rate:' + b.room, String(Date.now()), { expirationTtl: 60 });
        return json({ ok: true, push: await send(env, b.room, b.to, b.title, b.body) });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) { return json({ error: String(e && e.message || e) }, 500); }
  },
  async scheduled(event, env) {
    if (Number(vilnius({ hour: '2-digit', hour12: false }).format(new Date())) !== REMIND_HOUR) return;
    const today = vilnius({}).format(new Date());
    const list = await env.KV.list({ prefix: 'room:' });
    for (const k of list.keys) {
      const room = k.name.slice(5); if (!ROOM_RE.test(room)) continue;
      const players = await fsGet(`rooms/${room}/game/players`); if (!players) continue;
      for (const slot of ['a', 'b']) {
        const p = players.fields && players.fields[slot] && players.fields[slot].mapValue; if (!p) continue;
        const spin = await fsGet(`rooms/${room}/spins/${today}_${slot}`);
        const done = spin && spin.fields && spin.fields.status && spin.fields.status.stringValue === 'done';
        if (!spin) await send(env, room, slot, 'Ratas laukia 🎡', 'Šiandien dar nesukai. Neprarask serijos 🔥');
        else if (!done) await send(env, room, slot, 'Užduotis dar laukia 💌', clip(str(spin, 'text'), 140));
      }
    }
  }
};
