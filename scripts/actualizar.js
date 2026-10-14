// Robot de la Bolsa Laboral DSA (tope: 15,000 ofertas) — corre día por medio
// Fuentes: Jooble (una clave por país; clave gratuita = 500 solicitudes en total)
//          Careerjet (secreto CAREERJET_KEY; careerjet.com.pe) y
//          Get on Board (empleos tech de Latinoamérica, acceso público sin clave).
// Quita repetidas, elimina las antiguas y deja como máximo MAX_OFERTAS en ofertas.json
const fs = require("fs");

const MAX_OFERTAS = 15000;   // tope de ofertas activas
const DIAS_MAXIMO = 30;      // ofertas con más días se eliminan
const POR_CONSULTA = 20;     // resultados por consulta
// Páginas por palabra clave. Con la clave gratuita (500 solicitudes en total) dejar en 1.
// Cuando Jooble amplíe el límite, subir a 5 para acercarse a las 15,000 ofertas.
const PAGINAS = 1;

// País -> secreto de GitHub con su clave, dominio de Jooble, moneda y tipo de cambio aprox. a US$
const PAISES = {
  "Perú": ["JOOBLE_PE","pe","S/",0.27], "México": ["JOOBLE_MX","mx","MXN $",0.055],
  "Colombia": ["JOOBLE_CO","co","COP $",0.00025], "Chile": ["JOOBLE_CL","cl","CLP $",0.00107],
  "España": ["JOOBLE_ES","es","€",1.08], "Argentina": ["JOOBLE_AR","ar","ARS $",0.00085],
  "Ecuador": ["JOOBLE_EC","ec","US$",1], "Bolivia": ["JOOBLE_BO","bo","Bs",0.145],
  "Panamá": ["JOOBLE_PA","pa","US$",1], "Costa Rica": ["JOOBLE_CR","cr","₡",0.0019],
  "República Dominicana": ["JOOBLE_DO","do","RD$",0.017], "Guatemala": ["JOOBLE_GT","gt","Q",0.13],
  "Uruguay": ["JOOBLE_UY","uy","UYU $",0.025], "Paraguay": ["JOOBLE_PY","py","₲",0.00013],
  "Venezuela": ["JOOBLE_VE","ve","US$",1], "Honduras": ["JOOBLE_HN","hn","L",0.04],
  "El Salvador": ["JOOBLE_SV","sv","US$",1], "Nicaragua": ["JOOBLE_NI","ni","C$",0.027],
  "Puerto Rico": ["JOOBLE_PR","pr","US$",1], "Cuba": ["JOOBLE_CU","cu","US$",1]
};

// Área de la bolsa -> palabra clave de búsqueda
// Con PAGINAS = 1 solo se usa la primera palabra de cada área (13 consultas al día).
// Con el límite ampliado se usan todas.
const AREAS = {
  "Ingeniería": ["ingeniero", "ingeniero industrial", "ingeniero mecánico", "ingeniero electricista"],
  "Inteligencia artificial": ["inteligencia artificial", "machine learning", "científico de datos"],
  "Análisis de datos": ["analista de datos", "power bi", "business intelligence"],
  "Control de proyectos": ["control de proyectos", "planner", "project manager", "primavera p6"],
  "Minería": ["minería", "ingeniero de minas", "geólogo"],
  "Construcción": ["construcción", "residente de obra", "ingeniero civil", "oficina técnica"],
  "Supervisión": ["supervisor", "supervisor de seguridad", "supervisor de calidad"],
  "Recursos humanos": ["recursos humanos", "reclutamiento", "planillas"],
  "Contabilidad": ["contador", "asistente contable", "analista contable"],
  "Administración": ["administración", "asistente administrativo", "administrador"],
  "Finanzas": ["finanzas", "analista financiero", "tesorería"],
  "Negocios internacionales": ["comercio exterior", "importaciones", "exportaciones"],
  "Gestión empresarial": ["mejora continua", "jefe de operaciones", "analista de procesos"]
};

const ARCHIVO = "ofertas.json";

function numero(t) {
  t = t.replace(/[.,](?=\d{3}(\D|$))/g, "").replace(",", ".");
  return parseFloat(t);
}
function salario(texto, moneda, tasa) {
  if (!texto || /hora|hour/i.test(texto)) return null;
  const nums = (texto.match(/\d[\d.,]*/g) || []).map(numero).filter(n => n > 0);
  if (!nums.length) return null;
  let lo = nums[0], hi = nums[1] || nums[0];
  if (/k\b/i.test(texto) && lo < 1000) { lo *= 1000; hi *= 1000; }
  if (/año|anual|year/i.test(texto)) { lo /= 12; hi /= 12; }
  lo = Math.round(lo); hi = Math.round(hi);
  return { sal: { c: moneda, lo, hi }, usdMid: ((lo + hi) / 2) * tasa };
}
function modalidad(t) {
  if (/h[ií]brid/i.test(t)) return "Híbrido";
  if (/remot|teletrabajo|home office|desde casa/i.test(t)) return "Remoto";
  return "Presencial";
}
function tipo(t) {
  if (/pr[aá]ctic|intern|becari/i.test(t)) return "Prácticas";
  if (/medio tiempo|part/i.test(t)) return "Medio tiempo";
  return "Tiempo completo";
}

/* ---------------- Get on Board: público, sin clave ---------------- */
// Búsquedas por área (empleos de tecnología, datos, IA y proyectos). Solo Perú o 100% remoto.
const GOB_BUSQUEDAS = {
  "Análisis de datos": ["analista de datos", "business intelligence", "power bi", "data analyst"],
  "Inteligencia artificial": ["inteligencia artificial", "machine learning", "data scientist"],
  "Control de proyectos": ["project manager", "jefe de proyectos"],
  "Ingeniería": ["ingeniero de datos", "data engineer"],
  "Gestión empresarial": ["analista de procesos", "operaciones"]
};
function sinHtml(t) { return String(t || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim(); }
function gobModalidad(a) {
  const m = String(a.remote_modality || "");
  if (m === "fully_remote" || (a.remote && !m)) return "Remoto";
  if (m.indexOf("hybrid") >= 0) return "Híbrido";
  return "Presencial";
}
function gobEnPeru(a) {
  const c = (a.countries || []).map(x => String(x).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase());
  if (c.includes("peru")) return true;
  /* 100% remoto abierto a cualquier país (sin lista de países) */
  return gobModalidad(a) === "Remoto" && !c.length;
}
async function getOnBoard(mapa, ahora) {
  let consultas = 0, nuevas = 0, vistas = new Set();
  for (const [area, palabras] of Object.entries(GOB_BUSQUEDAS)) {
    for (const palabra of palabras) {
      try {
        const url = "https://www.getonbrd.com/api/v0/search/jobs?per_page=50&page=1&expand=%5B%22company%22%5D&query=" + encodeURIComponent(palabra);
        const r = await fetch(url, { headers: { Accept: "application/json" } });
        consultas++;
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        for (const it of (j.data || [])) {
          const a = it.attributes || {}, id = "gob-" + it.id;
          if (vistas.has(id) || !gobEnPeru(a) || !a.title) continue;
          vistas.add(id);
          const previa = mapa.get(id);
          if (!previa) nuevas++;
          const emp = (((a.company || {}).data || {}).attributes || {}).name || "Empresa confidencial";
          const remoto = gobModalidad(a) === "Remoto";
          const lo = +a.min_salary || 0, hi = +a.max_salary || lo;
          mapa.set(id, {
            id, title: String(a.title).trim(), area, company: String(emp).trim(),
            country: "Perú", city: remoto ? "Remoto" : "Perú",
            mode: gobModalidad(a), type: tipo(a.title + " " + sinHtml(a.description)), src: "getonbrd.com",
            link: (it.links && it.links.public_url) || ("https://www.getonbrd.com/jobs/" + it.id),
            snippet: sinHtml([a.description, a.functions, a.desirable].join(" ")).slice(0, 600),
            fecha: a.published_at ? new Date(a.published_at * 1000).toISOString() : ahora.toISOString(),
            visto: ahora.toISOString(),
            alta: previa ? (previa.alta || previa.visto) : ahora.toISOString(),
            sal: lo ? { c: "US$", lo, hi } : null, usdMid: lo ? (lo + hi) / 2 : 0
          });
        }
      } catch (e) { console.log(`Get on Board / ${palabra}: ${e.message}`); }
      await new Promise(s => setTimeout(s, 1500));   /* sin apuro: no saturar su servidor */
    }
  }
  return { consultas, nuevas };
}

/* ---------------- Careerjet: clave de publisher (CAREERJET_KEY) ---------------- */
/* Careerjet solo acepta IPs fijas, así que sus consultas salen por Fixie (secreto FIXIE_URL).
   El plan gratis de Fixie da 500 consultas al mes: el robot corre ~16 veces al mes,
   así que se hacen CJ_POR_CORRIDA consultas por vez (~416 al mes). */
const CJ_POR_CORRIDA = 26;
function porFixie(url, headers) {
  /* GET https a través del proxy de Fixie (túnel CONNECT), sin librerías extra */
  const http = require("http"), https = require("https"), tls = require("tls");
  const px = new URL(process.env.FIXIE_URL), destino = new URL(url);
  const cabeceraProxy = px.username
    ? { "Proxy-Authorization": "Basic " + Buffer.from(decodeURIComponent(px.username) + ":" + decodeURIComponent(px.password)).toString("base64") }
    : {};
  return new Promise((ok, mal) => {
    const c = http.request({ host: px.hostname, port: px.port || 80, method: "CONNECT",
      path: destino.hostname + ":443", headers: { Host: destino.hostname + ":443", ...cabeceraProxy } });
    c.setTimeout(30000, () => c.destroy(new Error("Fixie no responde")));
    c.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return mal(new Error("Fixie rechazó la conexión (HTTP " + res.statusCode + ")")); }
      const segura = tls.connect({ socket, servername: destino.hostname });
      const r = https.request({ host: destino.hostname, path: destino.pathname + destino.search, method: "GET",
        headers, createConnection: () => segura }, resp => {
        let txt = ""; resp.setEncoding("utf8");
        resp.on("data", d => txt += d);
        resp.on("end", () => ok({ ok: resp.statusCode < 300, status: resp.statusCode, text: txt }));
      });
      r.setTimeout(30000, () => r.destroy(new Error("Careerjet no responde")));
      r.on("error", mal); r.end();
    });
    c.on("error", mal); c.end();
  });
}
function cjBusquedas(ahora) {
  /* siempre la primera palabra de cada área + otras que van rotando en cada corrida */
  const fijas = [], resto = [];
  for (const [area, palabras] of Object.entries(AREAS)) palabras.forEach((p, i) => (i ? resto : fijas).push([area, p]));
  const cupo = Math.max(0, CJ_POR_CORRIDA - fijas.length);
  const vuelta = Math.floor(ahora.getTime() / 86400000 / 2);
  const extra = [];
  for (let i = 0; i < Math.min(cupo, resto.length); i++) extra.push(resto[(vuelta * cupo + i) % resto.length]);
  return fijas.concat(extra).slice(0, CJ_POR_CORRIDA);
}
async function careerjet(mapa, ahora) {
  const clave = process.env.CAREERJET_KEY;
  if (!clave) { console.log("Careerjet: falta el secreto CAREERJET_KEY (se salta)"); return { consultas: 0, nuevas: 0 }; }
  if (!process.env.FIXIE_URL) { console.log("Careerjet: falta el secreto FIXIE_URL (se salta)"); return { consultas: 0, nuevas: 0 }; }
  const auth = "Basic " + Buffer.from(clave + ":").toString("base64");
  let ip = "127.0.0.1";
  try { ip = (await (await fetch("https://api.ipify.org")).text()).trim() || ip; } catch (e) {}
  const ua = "DSA-Bolsa-Laboral/1.0 (+https://dsainstituto.com)";
  let consultas = 0, nuevas = 0, mostrado = false, fallos = 0;
  for (const [area, palabra] of cjBusquedas(ahora)) {
    try {
      const q = new URLSearchParams({ locale_code: "es_PE", keywords: palabra, location: "Perú", page_size: "50", page: "1",
        sort: "date", user_ip: ip, user_agent: ua });
      const r = await porFixie("https://search.api.careerjet.net/v4/query?" + q, { Authorization: auth, Accept: "application/json", "User-Agent": ua });
      consultas++;
      const txt = r.text;
      if (!r.ok) throw new Error("HTTP " + r.status + " " + txt.slice(0, 200));
      fallos = 0;
      const j = JSON.parse(txt);
      const jobs = j.jobs || j.results || (j.data && j.data.jobs) || [];
      if (!mostrado) { console.log("Careerjet responde. Campos:", Object.keys(j).join(", "), "| ejemplo:", JSON.stringify(jobs[0] || {}).slice(0, 300)); mostrado = true; }
      for (const o of jobs) {
        const url = o.url || o.link; if (!url || !o.title) continue;
        const id = "cj" + require("crypto").createHash("sha1").update(String(url)).digest("hex").slice(0, 20);
        const previa = mapa.get(id);
        if (!previa) nuevas++;
        const texto = `${o.title} ${o.description || ""}`;
        const s = salario(o.salary || "", "S/", 0.27);
        const f = Date.parse(o.date || o.created || "");
        mapa.set(id, {
          id, title: String(o.title).replace(/<[^>]+>/g, "").trim(), area, company: String(o.company || "Empresa confidencial").trim(),
          country: "Perú", city: String(o.locations || o.location || "Perú").split(",")[0].trim() || "Perú",
          mode: modalidad(texto), type: tipo(texto), src: String(o.site || "careerjet.com.pe"),
          link: url, snippet: String(o.description || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim(),
          fecha: f ? new Date(f).toISOString() : ahora.toISOString(), visto: ahora.toISOString(),
          alta: previa ? (previa.alta || previa.visto) : ahora.toISOString(),
          sal: s ? s.sal : null, usdMid: s ? s.usdMid : 0
        });
      }
    } catch (e) {
      console.log(`Careerjet / ${palabra}: ${e.message}`);
      /* si falla 3 veces seguidas (IP no autorizada, cupo de Fixie agotado...), no gastar más consultas */
      if (++fallos >= 3) { console.log("Careerjet: 3 fallos seguidos, se detiene por hoy"); break; }
    }
    await new Promise(s => setTimeout(s, 1200));
  }
  return { consultas, nuevas };
}

async function consultar(clave, dominio, palabra, pais, pagina) {
  const r = await fetch(`https://${dominio}.jooble.org/api/${clave}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keywords: palabra, location: pais, page: pagina, ResultOnPage: POR_CONSULTA })
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).jobs || [];
}

(async () => {
  let previo = { ofertas: [] };
  try { previo = JSON.parse(fs.readFileSync(ARCHIVO, "utf8")); } catch (e) {}
  const mapa = new Map(previo.ofertas.map(o => [o.id, o]));
  const ahora = new Date();
  let consultas = 0, nuevas = 0;

  for (const [pais, [secreto, dominio, moneda, tasa]] of Object.entries(PAISES)) {
    const clave = process.env[secreto];
    if (!clave) continue; // país sin clave todavía
    for (const [area, palabras] of Object.entries(AREAS)) {
     // En modo ahorro, cada día usa una palabra distinta del área (rota), para traer ofertas diferentes
     const diaDelAnio = Math.floor((ahora - new Date(ahora.getFullYear(), 0, 0)) / 864e5);
     for (const palabra of (PAGINAS === 1 ? [palabras[diaDelAnio % palabras.length]] : palabras)) {
      for (let pagina = 1; pagina <= PAGINAS; pagina++) {
      try {
        const jobs = await consultar(clave, dominio, palabra, pais, pagina);
        consultas++;
        for (const j of jobs) {
          const id = "jb" + j.id;
          const texto = `${j.title} ${j.snippet || ""} ${j.type || ""}`;
          const s = salario(j.salary, moneda, tasa);
          const previa = mapa.get(id);
          if (!previa) nuevas++;
          mapa.set(id, {
            id, title: (j.title || "").trim(), area, company: (j.company || "Empresa confidencial").trim(),
            country: pais, city: (j.location || pais).split(",")[0].trim(),
            mode: modalidad(texto), type: tipo(texto), src: j.source || "Jooble",
            link: j.link, snippet: (j.snippet || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim(),
            fecha: j.updated || ahora.toISOString(), visto: ahora.toISOString(),
            alta: previa ? (previa.alta || previa.visto) : ahora.toISOString(), // día en que entró a la bolsa
            sal: s ? s.sal : null, usdMid: s ? s.usdMid : 0
          });
        }
        if (jobs.length < POR_CONSULTA) break; // no hay más páginas: no gastar consultas
      } catch (e) { console.log(`Error en ${pais} / ${area}: ${e.message}`); break; }
      }
     }
    }
  }

  /* Careerjet (si falla, la bolsa sigue con las demás fuentes) */
  try { const c = await careerjet(mapa, ahora); consultas += c.consultas; nuevas += c.nuevas; console.log(`Careerjet: ${c.nuevas} nuevas`); }
  catch (e) { console.log("Careerjet no respondió: " + e.message); }

  /* Get on Board (si falla, la bolsa sigue con lo de Jooble) */
  try { const g = await getOnBoard(mapa, ahora); consultas += g.consultas; nuevas += g.nuevas; console.log(`Get on Board: ${g.nuevas} nuevas`); }
  catch (e) { console.log("Get on Board no respondió: " + e.message); }

  const limite = ahora.getTime() - DIAS_MAXIMO * 864e5;
  const sinVer = ahora.getTime() - 30 * 864e5; // no apareció en 30 días: se asume cerrada
  const ofertas = [...mapa.values()]
    .filter(o => new Date(o.fecha).getTime() >= limite && new Date(o.visto).getTime() >= sinVer)
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
    .slice(0, MAX_OFERTAS);

  fs.writeFileSync(ARCHIVO, JSON.stringify({ actualizado: ahora.toISOString(), ofertas }));
  console.log(`Consultas: ${consultas} | Nuevas: ${nuevas} | Total activas: ${ofertas.length}`);
})();
