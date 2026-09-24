RUSH POS v24.4
Fecha: 23 de septiembre de 2026
Proyecto: Punto de venta de Rush Club Pádel
Plataforma: Cloudflare Workers + D1 (`rush-pos-db`)
Estado de las versiones
Versión	Estado
v24.1	Login y creación de órdenes funcionando (confirmado).
v24.2 / v24.3 / v24.3.1	Cocina/Barra separadas, personas en una comanda, usuarios, lealtad. v24.3 falló por una tabla `sessions` ya existente; v24.3.1 lo corrigió con `pos_sessions`.
v24.4	Candidata a estable. Corrige que las bebidas no llegaban a Barra. Probada con una simulación (frontend + Worker + SQLite con el esquema real). Falta confirmarla en producción.
No hay versión marcada como estable todavía. Pasa a estable cuando funcione en Cloudflare:
Login -> Venta por personas -> Cocina/Barra -> Órdenes -> Cobrar -> Lealtad.
Problema corregido en v24.4: bebidas no llegaban a Barra
Causa: cada producto tiene una estación (`destination`: cocina o barra). Al agregar esa columna en D1 todos quedaron en `cocina` y no había forma de cambiarlo desde el sistema (solo con un SQL manual). Por eso las bebidas iban a Cocina.
Solución:
En Menú, cada categoría tiene los botones 🍳 Toda a Cocina y ☕ Toda a Barra, y cada producto tiene su selector de estación.
Si ningún producto está en Barra, el Menú muestra una alerta roja.
Al cambiar la estación, también se mueven las comandas que ya están abiertas (no hay que rehacerlas).
Crear producto ahora sí se guarda (con estación y categoría; la lista de categorías existentes se sugiere para evitar duplicados).
Desactivar producto ahora sí funciona.
Cocina y Barra se refrescan solas cada 8 segundos.
Solo el administrador puede editar el menú.
Primer paso al desplegar: Menú -> en la categoría de bebidas tocar ☕ Toda a Barra. No hace falta SQL.
Contenido
Archivo	Qué es
`server.js`	Worker: login con sesiones, usuarios, clientes, menú, mesas, órdenes, dashboard mínimo
`public/index.html`	Interfaz
`wrangler.toml`	Configuración de despliegue
`sql/migracion_d1.sql`	Referencia de cambios en D1 (no hay SQL obligatorio nuevo)
Cómo desplegar
Sube `server.js`, `wrangler.toml` y `public/index.html` (archivos sueltos) y despliega.
Abre en ventana privada o con Ctrl+Shift+R.
Entra como administrador.
Menú -> ☕ Toda a Barra en la categoría de bebidas.
Prueba: comanda con un alimento y una bebida; Cocina ve solo el alimento y Barra solo la bebida.
Pendiente
Notas por producto/persona (hoy son por comanda).
Corte de caja y egresos manuales.
Inventario (por ahora no se usa).
Renombrar/unir categorías duplicadas (por ahora se evita con la lista de sugerencias y se puede desactivar el duplicado).
Órdenes anteriores a v24.1 no tienen `items` y aparecen con total $0.
