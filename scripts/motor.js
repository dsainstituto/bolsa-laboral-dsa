/* =====================================================================
   MOTOR DE POSTULACIONES DSA
   Cada lunes, después de que el robot trae las ofertas del día
   (ofertas.json), elige para cada alumno las 20 que más le convienen y
   las deja en su campus (colección postulaciones/{alumnoId}).

   Alumnos que reciben ofertas: activos, con preferencias guardadas,
   con su autorización marcada y dentro de sus 12 meses.

   Secretos (GitHub > Settings > Secrets and variables > Actions):
     CAMPUS_SA          → contenido del archivo .json de la cuenta de servicio de Firebase (campus-dsa)
     ANTHROPIC_API_KEY  → clave de la API de Claude (si falta, elige solo por palabras clave)
   ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROYECTO = 'campus-dsa';
const POR_SEMANA = 20;
const CANDIDATAS = 60;          // las mejores por palabras clave que revisa Claude
const MODELO = 'claude-haiku-5-5';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROYECTO}/databases/(default)/documents`;
const SOLO = String(process.env.SOLO || '').trim().toLowerCase();
const FORZAR = /^s/i.test(String(process.env.FORZAR || ''));
const DIA = 86400000;

/* ---------------- utilidades ---------------- */
const espera = ms => new Promise(r => setTimeout(r, ms));
function sinTildes(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
const VACIAS = new Set(('de del la las el los y e o u en con para por a al un una sus su se que como mas sr jr '
  + 'analista asistente especialista junior senior practicante practicas gestion area').split(' '));
function palabras(s) { return sinTildes(s).split(/[^a-z0-9+#]+/).filter(w => w.length > 2 && !VACIAS.has(w)); }
/* lunes 00:00 de Lima (UTC-5) de la semana actual, en milisegundos */
function lunesLima(ahora) {
  const l = new Date((ahora || Date.now()) - 5 * 3600000);
  const dow = (l.getUTCDay() + 6) % 7;
  return Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate() - dow) + 5 * 3600000;
}
function portalDe(src) {
  const s = String(src || '').toLowerCase();
  const M = [['computrabajo', 'Computrabajo'], ['bumeran', 'Bumeran'], ['linkedin', 'LinkedIn'], ['indeed', 'Indeed'],
    ['buscojobs', 'BuscoJobs'], ['greenhouse', 'Greenhouse'], ['teamtailor', 'Teamtailor'], ['pandape', 'Pandapé'],
    ['jobleads', 'JobLeads'], ['workable', 'Workable'], ['hiringroom', 'HiringRoom'], ['jazzhr', 'JazzHR']];
  for (const [k, v] of M) if (s.includes(k)) return v;
  return s.replace(/^www\./, '').split('/')[0] || 'Web';
}
function limpiarCiudad(c) { return String(c || '').replace(/^Distrito de\s+/i, '').trim(); }

/* ---------------- Firestore (formato de valores) ---------------- */
function aFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(aFs) } };
  const fields = {}; for (const [k, x] of Object.entries(v)) if (x !== undefined) fields[k] = aFs(x);
  return { mapValue: { fields } };
}
function deFs(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(deFs);
  if ('mapValue' in v) { const o = {}; for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = deFs(x); return o; }
  return null;
}
function docObj(d) { const o = {}; for (const [k, x] of Object.entries(d.fields || {})) o[k] = deFs(x); return o; }

/* ---------------- acceso con la cuenta de servicio ---------------- */
let tokCache = { t: null, exp: 0 };
async function token() {
  if (tokCache.t && Date.now() < tokCache.exp) return tokCache.t;
  const sa = JSON.parse(process.env.CAMPUS_SA);
  const ahora = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sinFirma = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iss: sa.client_email, aud: 'https://oauth2.googleapis.com/token',
    iat: ahora, exp: ahora + 3600, scope: 'https://www.googleapis.com/auth/datastore' });
  const firma = crypto.createSign('RSA-SHA256').update(sinFirma).sign(sa.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + sinFirma + '.' + firma });
  const j = await r.json();
  if (!j.access_token) throw new Error('La cuenta de servicio (CAMPUS_SA) no es válida: ' + JSON.stringify(j).slice(0, 200));
  tokCache = { t: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000 };
  return tokCache.t;
}
async function fsPedir(url, opc = {}) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { ...opc, headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json', ...(opc.headers || {}) } });
    if (r.status === 429 || r.status >= 500) { await espera(1500 * (i + 1)); continue; }
    return r;
  }
  throw new Error('Firestore no responde: ' + url);
}
const CAMPOS_ALUMNO = ['nombre', 'email', 'activo', 'carrera', 'cargo', 'rubro', 'situacion', 'depto', 'pais', 'postu'];
async function alumnos() {
  const out = []; let pt = '';
  do {
    const q = new URLSearchParams({ pageSize: '300' });
    CAMPOS_ALUMNO.forEach(f => q.append('mask.fieldPaths', f));
    if (pt) q.set('pageToken', pt);
    const r = await fsPedir(`${BASE}/alumnos?${q}`);
    const j = await r.json();
    if (!r.ok) throw new Error('No se pudo leer alumnos: ' + JSON.stringify(j).slice(0, 300));
    (j.documents || []).forEach(d => out.push({ id: d.name.split('/').pop(), ...docObj(d) }));
    pt = j.nextPageToken || '';
  } while (pt);
  return out;
}
async function leerPost(id) {
  const r = await fsPedir(`${BASE}/postulaciones/${encodeURIComponent(id)}`);
  if (r.status === 404) return { existe: false, data: {} };
  const j = await r.json();
  if (!r.ok) throw new Error('No se pudo leer postulaciones/' + id);
  return { existe: true, data: docObj(j), updateTime: j.updateTime };
}
async function guardarPost(id, ofertas, previo) {
  const q = new URLSearchParams();
  q.append('updateMask.fieldPaths', 'ofertas'); q.append('updateMask.fieldPaths', 'actualizado');
  if (previo.existe) q.set('currentDocument.updateTime', previo.updateTime); else q.set('currentDocument.exists', 'false');
  const r = await fsPedir(`${BASE}/postulaciones/${encodeURIComponent(id)}?${q}`, { method: 'PATCH',
    body: JSON.stringify({ fields: { ofertas: aFs(ofertas), actualizado: aFs(Date.now()) } }) });
  if (r.status === 400 || r.status === 409 || r.status === 412) return false;   /* alguien lo cambió justo ahora: se reintenta */
  if (!r.ok) throw new Error('No se pudo guardar postulaciones/' + id + ': ' + (await r.text()).slice(0, 200));
  return true;
}

/* ---------------- elegir ofertas ---------------- */
function perfilDe(a, post) {
  const p = (a.postu && a.postu.prefs) || {};
  const ats = post.cvAts || {};
  return {
    puestos: String(p.puestos || ''), ciudad: String(p.ciudad || ''), modalidad: String(p.modalidad || ''), sueldo: String(p.sueldo || ''),
    carrera: String(a.carrera || a.rubro || ''), cargo: String(a.cargo || ''),
    resumen: String(ats.resumen || '').slice(0, 600),
    habilidades: (ats.habilidades || []).slice(0, 25).join(', '),
    experiencia: (ats.experiencia || []).slice(0, 4).map(e => [e.cargo, e.empresa].filter(Boolean).join(' en ')).join('; ')
  };
}
function puntaje(of, pf) {
  const tit = palabras(of.title), area = palabras(of.area), sn = palabras(of.snippet);
  const pu = palabras(pf.puestos), extra = palabras([pf.carrera, pf.cargo, pf.habilidades, pf.experiencia].join(' '));
  let s = 0;
  pu.forEach(w => { if (tit.includes(w)) s += 6; else if (sn.includes(w)) s += 2; if (area.includes(w)) s += 2; });
  extra.forEach(w => { if (tit.includes(w)) s += 2; else if (sn.includes(w)) s += 1; });
  /* frase completa del puesto dentro del título */
  pf.puestos.split(',').map(x => sinTildes(x).trim()).filter(x => x.length > 3).forEach(f => { if (sinTildes(of.title).includes(f)) s += 10; });
  const ciu = sinTildes(pf.ciudad), oc = sinTildes(of.city);
  if (ciu && oc && oc !== 'peru') s += (oc.includes(ciu) || (ciu === 'lima' && LIMA.some(d => oc.includes(d)))) ? 3 : -4;
  const mod = sinTildes(pf.modalidad);
  if (mod && mod !== 'cualquiera' && sinTildes(of.mode) && !sinTildes(of.mode).includes(mod.slice(0, 5))) s -= 2;
  return s;
}
const LIMA = ['lima', 'san isidro', 'surco', 'miraflores', 'ate', 'san borja', 'la molina', 'callao', 'jesus maria', 'lince', 'san miguel',
  'chorrillos', 'barranco', 'magdalena', 'surquillo', 'los olivos', 'independencia', 'san juan de lurigancho', 'brena', 'pueblo libre', 'cercado'];

async function claudeElige(pf, cands) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const lista = cands.map(o => ({ id: o.id, puesto: o.title, empresa: o.company, ciudad: o.city, modalidad: o.mode,
    area: o.area, detalle: String(o.snippet || '').replace(/\s+/g, ' ').slice(0, 220) }));
  const pedido = 'Eres reclutador en Perú. Elige las ' + POR_SEMANA + ' ofertas que mejor encajan con este alumno y dales una afinidad de 0 a 100.\n' +
    'Prioriza: el puesto que busca, su experiencia y habilidades, la ciudad y la modalidad. Descarta ofertas que no tengan relación.\n' +
    'Responde SOLO con JSON: [{"id":"...","afinidad":90,"motivo":"frase corta en español"}], ordenado de mayor a menor afinidad.\n\n' +
    'ALUMNO:\n' + JSON.stringify(pf) + '\n\nOFERTAS:\n' + JSON.stringify(lista);
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODELO, max_tokens: 2500, messages: [{ role: 'user', content: pedido }] }) });
      if (r.status === 429 || r.status >= 500) { await espera(4000 * (i + 1)); continue; }
      const j = await r.json();
      if (!r.ok) { console.log('  Claude respondió con error:', JSON.stringify(j).slice(0, 200)); return null; }
      const txt = (j.content || []).map(c => c.text || '').join('');
      const m = txt.match(/\[[\s\S]*\]/);
      const arr = m ? JSON.parse(m[0]) : [];
      const ok = new Set(cands.map(o => o.id));
      return arr.filter(x => x && ok.has(x.id)).map(x => ({ id: x.id, afinidad: Math.max(0, Math.min(100, Math.round(+x.afinidad || 0))),
        motivo: String(x.motivo || '').slice(0, 160) }));
    } catch (e) { console.log('  Claude falló:', e.message); await espera(3000); }
  }
  return null;
}

function nuevaOferta(o, afin, motivo, lunes, ahora) {
  return { id: 'o' + String(o.id).replace(/[^A-Za-z0-9-]/g, ''), ref: String(o.id), puesto: String(o.title || '').slice(0, 140),
    empresa: String(o.company || 'Empresa confidencial').slice(0, 100), ciudad: limpiarCiudad(o.city).slice(0, 60),
    modalidad: String(o.mode || '').slice(0, 30), portal: portalDe(o.src), url: String(o.link || ''), match: afin,
    motivo: motivo || '', sem: lunes, estado: 'pendiente', hist: [{ e: 'seleccionada', t: ahora, por: 'Sistema DSA' }] };
}

async function procesar(a, ofertas, lunes, ahora) {
  for (let intento = 0; intento < 3; intento++) {
    const prev = await leerPost(a.id);
    const ya = prev.data.ofertas || [];
    if (!FORZAR && ya.some(o => o.sem === lunes && o.hist && o.hist[0] && o.hist[0].por === 'Sistema DSA')) return 'ya-tenía';
    const usadas = new Set(ya.map(o => o.ref || o.id));
    const pf = perfilDe(a, prev.data);
    const libres = ofertas.filter(o => !usadas.has(String(o.id)) && o.link);
    const orden = libres.map(o => ({ o, s: puntaje(o, pf) })).filter(x => x.s > 0).sort((x, y) => y.s - x.s);
    if (!orden.length) return 'sin-coincidencias';
    const cands = orden.slice(0, CANDIDATAS).map(x => x.o);
    let elegidas = await claudeElige(pf, cands);
    if (!elegidas || !elegidas.length) {
      const max = orden[0].s;
      elegidas = orden.slice(0, POR_SEMANA).map(x => ({ id: x.o.id, afinidad: Math.max(55, Math.round(60 + 38 * x.s / max)), motivo: '' }));
    }
    const porId = new Map(cands.concat(orden.slice(0, POR_SEMANA).map(x => x.o)).map(o => [o.id, o]));
    const nuevas = elegidas.slice(0, POR_SEMANA).map(x => nuevaOferta(porId.get(x.id), x.afinidad, x.motivo, lunes, ahora)).filter(o => o.url);
    /* si se fuerza, se reemplazan las de esta semana que aún no se postularon */
    const base = FORZAR ? ya.filter(o => !(o.sem === lunes && o.estado === 'pendiente')) : ya;
    const ok = await guardarPost(a.id, base.concat(nuevas), prev);
    if (ok) return nuevas.length + ' ofertas';
    await espera(1000);
  }
  return 'no se pudo guardar (otro cambio al mismo tiempo)';
}

function elegible(a, ahora) {
  if (a.activo === false) return false;
  const P = a.postu || {};
  if (!P.prefs || !String(P.prefs.puestos || '').trim()) return false;
  if (!P.aut || P.aut.ok !== true) return false;
  const ini = Number(P.inicio || 0);
  if (ini && ahora > ini + 366 * DIA) return false;   /* terminaron sus 12 meses */
  if (SOLO && String(a.email || '').trim().toLowerCase() !== SOLO) return false;
  return true;
}

async function main() {
  if (process.env.EVENTO === 'workflow_run') {
    const diaLima = new Date(Date.now() - 5 * 3600000).getUTCDay();
    if (diaLima !== 1) { console.log('Hoy no es lunes: el motor solo elige ofertas los lunes.'); return; }
  }
  if (!process.env.CAMPUS_SA) { console.log('Falta el secreto CAMPUS_SA. Agrégalo en Settings > Secrets and variables > Actions.'); process.exit(1); }
  if (!process.env.ANTHROPIC_API_KEY) console.log('Aviso: falta ANTHROPIC_API_KEY; se elegirá solo por palabras clave.');
  const archivo = path.join(__dirname, '..', 'ofertas.json');
  const datos = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  const ahora = Date.now(), lunes = lunesLima(ahora);
  const ofertas = (datos.ofertas || []).filter(o => (o.country || 'Perú') === 'Perú');
  console.log(`Ofertas disponibles (Perú): ${ofertas.length} · actualizadas: ${datos.actualizado}`);
  const todos = await alumnos();
  const lista = todos.filter(a => elegible(a, ahora));
  console.log(`Alumnos en el campus: ${todos.length} · reciben ofertas: ${lista.length}${SOLO ? ' (solo ' + SOLO + ')' : ''}`);
  let i = 0;
  const trabajar = async () => {
    while (i < lista.length) {
      const a = lista[i++];
      try { console.log(`- ${a.nombre || a.id}: ${await procesar(a, ofertas, lunes, ahora)}`); }
      catch (e) { console.log(`- ${a.nombre || a.id}: ERROR ${e.message}`); }
    }
  };
  await Promise.all([trabajar(), trabajar(), trabajar()]);
  console.log('Listo.');
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main, lunesLima, puntaje, perfilDe, aFs, deFs, portalDe, nuevaOferta, elegible, procesar, alumnos };
