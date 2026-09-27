// Robot diario de la Bolsa Laboral DSA (tope: 15,000 ofertas)
// Trae ofertas de Jooble (una clave por país), quita repetidas,
// elimina las antiguas y deja como máximo MAX_OFERTAS en ofertas.json
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

  const limite = ahora.getTime() - DIAS_MAXIMO * 864e5;
  const sinVer = ahora.getTime() - 30 * 864e5; // no apareció en 30 días: se asume cerrada
  const ofertas = [...mapa.values()]
    .filter(o => new Date(o.fecha).getTime() >= limite && new Date(o.visto).getTime() >= sinVer)
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
    .slice(0, MAX_OFERTAS);

  fs.writeFileSync(ARCHIVO, JSON.stringify({ actualizado: ahora.toISOString(), ofertas }));
  console.log(`Consultas: ${consultas} | Nuevas: ${nuevas} | Total activas: ${ofertas.length}`);
})();
