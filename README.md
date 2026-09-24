RUSH POS v24.3
Fecha: 23 de septiembre de 2026
Proyecto: Punto de venta de Rush Club Pádel
Plataforma: Cloudflare Workers + D1 (`rush-pos-db`)
Estado de las versiones
Versión	Estado
v24.1	Login y creación de órdenes funcionando (confirmado).
v24.2	Cocina/Barra con "listo" separado, ticket 80 mm. Sustituida por v24.3.
v24.3	Candidata a estable. Probada de extremo a extremo con una simulación (frontend + Worker + SQLite con el esquema real). Falta confirmarla en producción.
No hay versión marcada como estable todavía. Pasa a estable cuando funcione en Cloudflare:
Login -> Usuarios -> Venta por personas -> Cocina/Barra -> Órdenes -> Cobrar -> Lealtad.
Cambios en v24.3
1. Usuarios (antes no aparecían)
Lista todos los usuarios de D1 (los 4 anteriores y los nuevos).
Crear usuario, cambiar contraseña (botón 🔑) y eliminar (botón 🗑️).
Solo el administrador puede gestionarlos (el servidor lo exige).
No se puede eliminar a uno mismo ni al único administrador.
Contraseñas con PBKDF2-SHA256 y sal aleatoria.
Usuarios anteriores: no se puede leer su contraseña vieja. Aparecen con "⚠️ Falta contraseña nueva": el admin les pone una con 🔑.
El acceso de respaldo `admin/admin` se apaga solo en cuanto exista un admin con contraseña nueva.
Sesiones reales guardadas en D1 (tabla `sessions`, se crea sola). El servidor rechaza cualquier petición sin sesión (401).
Menús por rol: admin ve todo; mesero: Venta, Canchas, Mesas, Órdenes; cocina: Cocina; barra: Barra.
2. Notas de cocina y barra
Las notas ahora se guardan estructuradas (`{type, cocina, barra}`), ya no como texto que había que interpretar.
Cocina ve solo la nota de cocina; barra ve solo la de barra. También salen así en el ticket interno y en Órdenes.
Lee también las órdenes viejas en formato de texto.
3. Venta por personas (una sola comanda)
Ya no se pregunta cuántas personas son.
La Persona 1 pide, se toca "➕ Nueva persona", pide la Persona 2, y así. Todas van en la misma comanda.
Si la mesa ya tiene una comanda abierta, aparece un aviso azul y lo que se envíe se agrega a esa misma comanda, continuando con la siguiente persona (hay botón para crear una comanda nueva si se prefiere).
Cocina y Barra muestran mesa, y los platos agrupados por persona.
Las notas de las rondas se acumulan por estación.
4. Lealtad
Los clientes salen automáticamente de las órdenes (nombre y WhatsApp que captura el mesero), con visitas, total gastado y última visita.
Búsqueda, selección múltiple y mensaje individual 💬.
Campaña: se escribe el mensaje (con `{nombre}`), se seleccionan clientes y el sistema abre WhatsApp con el mensaje listo para cada uno; se da enviar y "Abrir siguiente".
El envío 100 % automático sin tocar nada requiere la API oficial de WhatsApp Business (Meta), que no está incluida.
Otros
Los datos que se muestran (nombres, notas) se escapan para evitar HTML no deseado.
Solo el admin puede borrar órdenes (también en el servidor).
Los cobros registran el usuario que cobró.
El WhatsApp se limpia a 10 dígitos aunque se pegue con espacios o +52.
Contenido
Archivo	Qué es
`server.js`	Worker: login con sesiones, usuarios, clientes, menú, mesas, órdenes, dashboard mínimo
`public/index.html`	Interfaz
`wrangler.toml`	Configuración de despliegue
`sql/migracion_d1.sql`	Referencia de cambios en D1 (sin cambios nuevos obligatorios en v24.3)
Cómo desplegar
Sube `server.js`, `wrangler.toml` y `public/index.html` (archivos sueltos) y despliega.
Abre en ventana privada o con Ctrl+Shift+R.
Entra con `admin` / `admin`.
Ve a Usuarios, y ponle contraseña nueva a tu usuario admin (🔑) y a los demás usuarios.
Al hacerlo, `admin/admin` deja de funcionar.
La primera vez todos tendrán que iniciar sesión otra vez (las sesiones viejas ya no valen).
Pendiente
Catálogo de menú: categorías existentes/nuevas, evitar duplicados, crear/desactivar productos (hoy no se guardan).
Notas por producto/persona (hoy son por comanda).
Corte de caja y egresos manuales.
Inventario (por ahora no se usa).
Cocina y Barra no se actualizan solas: usar el botón de actualizar.
Órdenes anteriores a v24.1 no tienen `items` y aparecen con total $0.
