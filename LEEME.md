# Bolsa Laboral DSA

- docs/index.html → la página de la bolsa (se publica con GitHub Pages)
- docs/ofertas.json → las ofertas; lo llena el robot cada mañana
- scripts/actualizar.js → el robot (Jooble, tope 15,000 ofertas, máximo 30 días)
- .github/workflows/actualizar.yml → programa el robot a las 6:00 a. m. de Lima

Claves: se guardan en Settings > Secrets and variables > Actions,
una por país: JOOBLE_PE, JOOBLE_MX, JOOBLE_CO, JOOBLE_CL, JOOBLE_ES, etc.
Los países sin clave simplemente se saltan.
