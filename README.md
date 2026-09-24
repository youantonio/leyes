RUSH POS v24.2
Fecha: 23 de septiembre de 2026
Proyecto: Punto de venta de Rush Club Pádel
Plataforma: Cloudflare Workers + D1 (`rush-pos-db`)
Estado de las versiones
Versión	Estado
v24.1	Login y creación de órdenes funcionando (confirmado por Antonio). Flujo completo sin probar.
v24.2	Candidata a estable. Pasa a estable al confirmar en producción: Venta -> Cocina/Barra (listo por separado) -> Órdenes -> Cobrar -> Caja.
No hay versión marcada como estable todavía.
Cambios en v24.2
Cocina y Barra independientes. Cada estación ve solo sus productos y marca "listo" por separado. La orden pasa a `ready` cuando ambas terminan. Si se añade un producto después, reaparece en su estación.
Personas. En Venta se indica cuántas personas son y se elige "Agregando para: Persona N". El carrito, Cocina, Barra, Órdenes y tickets agrupan por persona.
Añadir a una orden abierta: la persona se elige de una lista (Persona 1..N o "Persona nueva").
Ticket para impresora térmica de 80 mm. Doble ticket: comprobante del cliente (por persona, con subtotales) y comanda interna (Cocina y Barra por separado). Cada uno sale en su propia hoja para cortar. El corte de caja usa el mismo formato.
La cantidad de personas se guarda en las notas de la orden (`👥 N`); no requiere cambios en D1.
Contenido
Archivo	Qué es
`server.js`	Worker: login, menú, mesas, órdenes, dashboard mínimo
`public/index.html`	Interfaz
`wrangler.toml`	Configuración de despliegue
`sql/migracion_d1.sql`	Columnas nuevas para D1 (ya ejecutadas en v24.1; no hay SQL nuevo en v24.2)
Cómo desplegar
Sube `server.js`, `wrangler.toml` y `public/index.html` (archivos sueltos) y despliega.
Abre en ventana privada o con Ctrl+Shift+R.
Entra con `admin` / `admin`.
Pendiente
Catálogo de menú: elegir categoría existente o crear una nueva; evitar duplicados; `POST/PATCH /api/menu`.
Usuarios: listar los de D1, crear, cambiar contraseña y eliminar (requiere conocer cómo se generó `password_hash`).
Campaña masiva de WhatsApp alimentada con los clientes capturados en las órdenes.
Corte de caja y egresos manuales.
Inventario (por ahora no se usa).
Seguridad: respaldo `admin/admin` en el código y el servidor no valida el token.
Órdenes anteriores a v24.1 no tienen `items` y aparecen con total $0.
