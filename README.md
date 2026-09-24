RUSH POS v24.5
Fecha: 24 de septiembre de 2026
Proyecto: Punto de venta de Rush Club Pádel
Plataforma: Cloudflare Workers + D1 (`rush-pos-db`)
Estado de las versiones
Versión	Estado
v24.1	Login y creación de órdenes funcionando (confirmado).
v24.2 - v24.3.1	Cocina/Barra separadas, personas en una comanda, usuarios, lealtad, sesiones (`pos_sessions`).
v24.4	Estación por producto/categoría; bebidas a Barra.
v24.5	Candidata a estable. Catálogo tipo Starbucks: secciones, categorías y clasificación automática. Probada con simulación (frontend + Worker + SQLite con el esquema real y un menú de 45 productos). Falta confirmarla en producción.
No hay versión marcada como estable todavía.
Cómo se organiza el menú (inspirado en Starbucks)
Starbucks separa Bebidas y Alimentos, y dentro de cada una usa categorías que el cliente entiende por cómo las pide (café caliente, café frío, frappé, té, desayuno, panadería...). Arriba destaca lo más popular. RUSH POS hace lo mismo:
```
Sección  ->  Categoría  ->  Producto
🍳 Alimentos (Cocina)          ☕ Bebidas (Barra)
  Desayunos                      Café caliente
  Tacos y antojitos              Café frío
  Hamburguesas y sándwiches      Té e infusiones
  Ensaladas y bowls              Frappés y licuados
  Botanas y para compartir       Jugos y aguas frescas
  Postres y panadería            Refrescos, agua e hidratación
                                 Cervezas y micheladas
                                 Cocteles y licores
```
La estación se hereda de la sección: todo lo de Alimentos va a Cocina y todo lo de Bebidas va a Barra. Ya no hay que asignarla producto por producto (aunque sigue disponible el ajuste manual).
En Venta
Pestañas grandes por sección (color de Cocina/Barra) y, debajo, las categorías de esa sección con su conteo.
⭐ Más pedidos: los 8 productos más vendidos en los últimos 30 días.
El buscador funciona en todo el menú, sin importar la sección.
Cada producto lleva una franja del color de su estación.
En Menú
Secciones y categorías: crear, renombrar y eliminar. Cambiar la estación de una sección mueve todos sus productos (y las comandas abiertas).
Clasificar productos: botón ✨ Sugerir clasificación automática (por palabras del nombre). Se revisa y se toca Guardar.
Crear producto con categoría; el sistema no permite nombres duplicados (adiós al taco repetido).
Eliminar una categoría no borra sus productos: quedan "sin clasificar".
D1: qué cambia en la base de datos
No tienes que correr SQL. Al primer uso el Worker crea solo:
Tabla `pos_menu_sections` (secciones)
Tabla `pos_menu_categories` (categorías)
Columna `menu_items.category_id`
Las 2 secciones y 14 categorías iniciales
No modifica ni borra datos existentes. Ver `sql/migracion_d1.sql` para las consultas de verificación.
Cómo desplegar
Sube `server.js`, `wrangler.toml` y `public/index.html` (archivos sueltos) y despliega.
Abre en ventana privada o con Ctrl+Shift+R y entra como administrador.
Menú -> ✨ Sugerir clasificación automática -> revisa -> 💾 Guardar.
Corrige a mano lo que no coincida (cada producto tiene su selector de categoría).
Ve a Venta y revisa las pestañas.
Pendiente
Notas por producto/persona (hoy son por comanda).
Producto "agotado" temporal.
Orden manual (subir/bajar) de categorías.
Corte de caja y egresos manuales.
Inventario (por ahora no se usa).
