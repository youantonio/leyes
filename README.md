RUSH POS v27.1 — "The Rush: Club · Café · Cocina"
Fecha: 25 de septiembre de 2026
Plataforma: Cloudflare Workers + D1 (`rush-pos-db`)
Estado de las versiones
Versión	Estado
v24.1 – v25.0	Base funcional completa: comandas por persona, catálogo tipo Starbucks, usuarios, caja, inventario, lealtad, página pública, pedidos externos.
v26.0	Rediseño, repartidores, envío, WhatsApp local.
v26.1	Emparejador de fotos por nombre, aceptar URLs además de subir archivo.
v26.2	19 fotos identificadas y renombradas en Drive.
v26.3	Candidata a estable. Corrige que los pedidos externos no sumaban sello de lealtad, y que la tarjeta digital no se actualizaba sola. 19 fotos sin nombre revisadas una por una e identificadas visualmente; 16 quedaron renombradas en tu Drive y agregadas al catálogo (118 fotos en total). Las 3 restantes eran duplicados de fotos que ya tenías. Fotos de Drive emparejadas automáticamente por nombre; ahora las fotos también se pueden pegar como URL, no solo subir archivo. Rediseño visual del menú público, fotos de producto, repartidores con ubicación en vivo (gratis), envío automático, plantillas de WhatsApp, canje de recompensa, notas por producto. Probada con pruebas automatizadas del servidor y regresión completa de versiones anteriores. Falta confirmarla en producción.
v26.4	Candidata a estable. WhatsApp de pedidos según el admin en turno, configurable en el panel. Corrige el mensaje de WhatsApp roto del menú público, precios manipulables, folios repetidos y la ventana de WhatsApp bloqueada en iPhone. Agrega mesa/cancha. Falta confirmarla en producción.
v27.0	Candidata a estable. Fotos en Cloudflare R2 (con respaldo automático desde Drive), rol Editor de carta, y carta pública rediseñada con la base de Gemini conectada a todo el sistema. Falta confirmarla en producción.
v27.1	Candidata a estable. Carta con diseño Gemini intacto cuando no hay foto, fotos por 3 rutas, subida de fotos en lote por nombre, prueba de fotos y opción para ocultarlas.
No hay versión marcada como estable todavía.
---
1. Menú público — rediseño completo (`/menu.html`)
El bug que reportaste: al tocar "Estoy en el club" no pasaba nada visible. Corregido: ahora hace scroll automático directo al menú.
El rediseño visual: cambié la estructura completa, no solo colores:
Encabezado tipo "hero" con degradado y tipografía serif para los títulos (Fraunces), inspirado en apps de delivery como Uber Eats/Rappi, pero con la paleta verde+dorado de "The Rush".
Tarjetas de producto grandes, con foto (o un degradado de color con ícono si aún no subes foto — nunca se ve una casilla vacía y gris).
Al tocar un producto se abre una ficha con foto grande, descripción y selector de cantidad, en vez de agregarse de golpe sin avisar.
Buscador, secciones y categorías con la misma jerarquía que ya usas en el admin.
Fotos de producto — cómo se cargan: en Menú → Nuevo producto, hay un campo para subir una foto desde tu celular o computadora. Se comprime automáticamente en el navegador antes de guardarse (para no saturar la base de datos) y se ve de inmediato en el menú público. También puedes subir o cambiar la foto de un producto ya existente, desde la tabla de clasificación.
Nota honesta: las fotos se guardan directo en la base de datos (D1), lo cual es gratis y funciona bien para un menú de tamaño normal. Si algún día suben cientos de fotos en alta resolución, seguirá una migración a almacenamiento de archivos (Cloudflare R2) — te aviso si tu catálogo llega a ese punto, no es algo que debas resolver ahora.
Nombre del producto bien escrito: al escribir el nombre de un producto nuevo (ej. "taco de arrachera"), aparece abajo una sugerencia en mayúsculas/minúsculas correctas ("Taco de Arrachera") que aceptas con un clic. Ya no dependes de escribirlo bien a mano.
2. Repartidores y envío a domicilio (Fase B/C/D, con opciones gratuitas)
Fase B — WhatsApp (versión local, sin API de pago, como pediste)
En Órdenes, cualquier pedido que llegó por la página web tiene un botón 💬 Responder por WhatsApp con 4 plantillas listas para editar y enviar:
📝 Confirmación de pedido
💳 Método de pago (usa los datos de transferencia que guardes en Configuración)
🛵 Va en camino
✅ Entregado
Cada plantilla se arma sola con los datos del pedido (folio, total, dirección) y la puedes editar antes de mandarla — abre WhatsApp con el mensaje listo.
Fase C — Repartidores
Nuevo rol de usuario: Repartidor (se crea igual que los demás, en Usuarios).
En Órdenes, cada pedido a domicilio tiene una barra para asignar repartidor y avanzar su estatus: Recibido → Preparando → Salió → En camino → Entregado.
El repartidor entra con su usuario y ve 🛵 Mis entregas: sus pedidos asignados, con un botón para avanzar al siguiente estatus.
Fase D — Envío automático y mapa en vivo, 100% gratis
Costo de envío automático: al escribir su dirección, el cliente toca "Ubicar mi dirección" y el sistema calcula la distancia real desde el club (usando el buscador gratuito de OpenStreetMap) y aplica tu tarifa base + $/km, configurables en Configuración → Envío a domicilio.
Mapa en vivo, sin apps ni SDKs de pago: el repartidor activa "📍 Compartir mi ubicación" en su pantalla de Mis entregas — usa el GPS que ya trae su celular, sin instalar nada. El cliente entra a su link de seguimiento (`/seguimiento.html`, se genera solo con cada pedido) y ve su pedido avanzando de estatus, y si el repartidor está compartiendo ubicación, lo ve como un punto en un mapa gratuito.
Límite honesto: esto solo funciona mientras el repartidor mantiene esa pantalla abierta (pantalla prendida). No sigue en segundo plano como una app nativa — eso sí requeriría inversión en una app aparte.
Dirección estructurada: el pedido a domicilio ahora pide, como pediste: calle, número, colonia, referencia (por si se pierden), nombre de quien recibe, y confirma el WhatsApp.
3. Notas por producto (ya no solo por comanda completa)
En Venta, cada línea del carrito tiene un botón 📝 para ponerle una nota a ESE producto específico (ej. "sin cebolla" solo en el taco de la Persona 2, no en toda la comanda). Se ve en Cocina, Barra, Órdenes y en el ticket, junto al producto exacto.
4. Canje de recompensa integrado
En Órdenes, junto al botón de tarjeta, ahora hay 🎁 Canjear: si el cliente ya ganó una recompensa de lealtad, se descuenta con un clic (antes solo existía el endpoint, sin botón).
---
Fotos de Drive — cómo se cargan en v26.1
Conectaste Google Drive y leí tu carpeta completa: 131 fotos. De esas, 102 tienen nombre de platillo reconocible (bebidas y comida: gringas, volcanes, burritos, tacos, hamburguesas) y quedaron mapeadas dentro del sistema. Las ~20 restantes se guardaron como `IMG_46xx.JPG` (nombre de cámara) y no se pueden emparejar solas — habría que renombrarlas en Drive con el nombre del platillo, o subirlas a mano.
Cómo aplicarlas: en Menú, nuevo botón 📷 Sugerir fotos desde Drive. Compara el nombre de cada producto sin foto contra el catálogo de 102 fotos (ignora tamaños como "16 oz" o "450 ml", acentos y mayúsculas), te muestra las coincidencias con miniatura, puedes quitar las que no te convenzan, y con un clic las aplica todas.
Importante sobre las fotos: quedan enlazadas directo a tu Google Drive (no se copian a la base de datos). Eso significa:
Si mueves, renombras o eliminas el archivo en Drive, la foto deja de verse en el menú.
El archivo debe seguir compartido como "cualquiera con el enlace puede ver" para que se muestre en la página pública (ya lo está, por cómo compartiste la carpeta).
Si algún día prefieres que las fotos vivan dentro del sistema (más seguro a largo plazo, no depende de Drive), es la misma migración a Cloudflare R2 que ya mencioné — se las subes una vez, y de ahí en adelante el sistema no depende de tu Drive.
El campo de imagen ahora acepta dos formas: subir un archivo (se guarda comprimido dentro del sistema) o pegar/aplicar una URL como la de Drive. Puedes mezclar ambas según el producto.
D1: qué cambia en la base de datos
No tienes que correr SQL. El Worker crea/agrega solo:
Columna `image` en `menu_items`
Columnas `delivery_status`, `driver_id`, `delivery_lat`, `delivery_lng`, `shipping_cost`, `tracking_token`, `delivery_address`, `receiver_name` en `orders`
Tabla `pos_driver_locations`
Configuración nueva: ubicación del negocio, tarifa de envío, datos de pago
Rol `repartidor` disponible en Usuarios
No modifica ni borra nada existente.
Cómo desplegar
Sube todos los archivos (`server.js`, `wrangler.toml`, `public/index.html`, `public/menu.html`, `public/tarjeta.html`, `public/seguimiento.html`) y despliega.
Entra como admin → Configuración: revisa/ajusta la ubicación del negocio (o deja Pachuca centro por default), tarifa de envío, y datos de transferencia.
Menú: sube al menos una foto de prueba y usa la sugerencia de nombre en un producto nuevo.
Usuarios: crea un usuario de prueba con rol Repartidor.
Haz un pedido de prueba a domicilio desde `/menu.html`, asígnale el repartidor de prueba desde Órdenes, y activa "Compartir ubicación" desde el usuario repartidor para ver el flujo completo en `/seguimiento.html`.
Pendiente
Cargar las fotos de tu carpeta de Drive (pendiente de que conectes el acceso).
Costo de envío con ruta real por calle (hoy es línea recta) — requeriría un servicio de rutas, hay opciones gratuitas con límites que podemos evaluar si la línea recta no es suficientemente precisa para ti.
Clon de Uber para Pachuca (proyecto aparte, en pausa, listo para retomar).

v26.2 — Las 19 fotos sin nombre, revisadas una por una
Descargué y vi cada una de las 19 fotos que quedaron como `IMG_46xx.JPG`. 16 eran platillos nuevos que no tenías nombrados; las renombré directo en tu Google Drive y las agregué al catálogo del sistema:
Nombre nuevo
Moca helado
Matcha con foam de moras
Matcha con foam de caramelo
Matcha con foam de vainilla
Matcha con foam de taro
Matcha tradicional ceremonial
Frappe de maracuya
Enchiladas de pollo
Chilaquiles verdes tradicionales
Chilaquiles verdes con huevo
Chilaquiles verdes con arrachera
Molletes de pollo
Molletes con tocino
Torrejas francesas con frutos rojos
Omelette con tocino
Sándwich de huevo, tocino y queso
Las otras 3 (`IMG_4618`, dos copias de `IMG_4616`) resultaron ser fotos duplicadas de "Strawberry Matcha" y "Mango Matcha", que ya tenías nombradas — las dejé como "(alterna)" en Drive para no perderlas, pero no hacía falta agregarlas de nuevo al catálogo.
El catálogo de fotos ya tiene 118 platillos. El botón 📷 Sugerir fotos desde Drive en Menú ahora busca contra las 118, no solo las 102 originales.

v26.3 — Bug: pedidos externos no sumaban sello de lealtad
Lo que reportaste: cobraste un pedido (ej. Dulce) y su tarjeta digital no se actualizó con la visita.
Causa real, confirmada con una prueba: el formulario 🛵 Capturar pedido externo (Rappi/Uber/directo) nunca preguntaba ni guardaba el consentimiento de lealtad — se guardaba en "no" sin que se viera en pantalla. Por eso, al cobrar esos pedidos, el sistema no sumaba el sello: no tenía permiso guardado para hacerlo. Los pedidos hechos desde Venta (mesero) o desde la página pública sí funcionaban bien, porque esos dos sí llevaban la casilla.
Corregido:
El modal de pedido externo ahora tiene la misma casilla ✅ "Inscribir a tarjeta de lealtad" que ya tenían los otros dos flujos.
Probé el escenario exacto: pedido externo con lealtad → cobrar → la tarjeta pasa de 0 a 1 sello correctamente.
Además corregí que la tarjeta no se refrescaba sola. Si el mesero le mostraba el link al cliente antes de cobrar, la página se quedaba congelada en "0 sellos" aunque el cobro sí hubiera sumado el sello por dentro — solo hacía falta recargar. Ahora `/tarjeta.html` se actualiza sola cada 15 segundos y tiene un botón "↻ Actualizar" para revisarlo al instante.

v26.4 — WhatsApp del admin en turno + correcciones
Fecha: 25 de septiembre de 2026
Nuevo: WhatsApp según el admin en turno
Usuarios: cada administrador tiene su WhatsApp (botón 📱 WhatsApp, o al crear el usuario).
Configuración → 📲 Admin en turno: eliges quién recibe los pedidos, o tocas 🙋 Tomar el turno yo.
Arriba, junto a tu nombre, se ve a quién le están llegando los pedidos. Tócalo para ir a Configuración.
Si nadie está en turno (o su número se borra), los pedidos llegan al WhatsApp general de respaldo.
Errores corregidos
Mensaje de WhatsApp roto: el menú público mandaba el texto con `\n` literales en vez de saltos de línea. Corregido.
Teléfono con espacios: "771 123 4567" se rechazaba. Ahora se limpia solo.
Precios manipulables: el servidor aceptaba el precio que mandaba el navegador (alguien podía pedir a $0). Ahora el precio siempre sale de D1.
WhatsApp bloqueado en iPhone: Safari bloqueaba la ventana que se abría sola. Ahora sale una pantalla de "¡Pedido recibido!" con botón para enviar.
Link de seguimiento perdido: antes aparecía 2 segundos en un aviso. Ahora queda en la pantalla de confirmación.
Folios repetidos: dos pedidos en el mismo minuto tenían el mismo folio, y la hora salía en UTC. Ahora usa hora de México + 2 letras (ej. `WEB-2509-1917-2E`).
Mesa o cancha: el pedido "Estoy en el club" ahora pregunta mesa/cancha y se ve en Cocina/Barra.
D1
No tienes que correr SQL. El Worker agrega solo la columna `whatsapp` en `users` y la configuración `whatsapp_on_duty`.
Prueba rápida
Usuarios → 📱 WhatsApp a tu usuario admin.
Configuración → 🙋 Tomar el turno yo.
Haz un pedido desde `/menu.html` → debe abrir WhatsApp hacia tu número, con saltos de línea bien.

---
v27.0 — Fotos en R2, Editor de carta y carta rediseñada
Fecha: 25 de septiembre de 2026
⚠️ Paso 1 ANTES de desplegar: crear el bucket de R2
Cloudflare → R2 Object Storage → Create bucket.
Nombre exacto: `rush-fotos` → Create.
Ya está en `wrangler.toml` (binding `PHOTOS`). Ahora sí, sube los archivos y despliega.
Si despliegas sin crear el bucket, Cloudflare marca error. Si prefieres esperar, borra el bloque `[[r2_buckets]]` de `wrangler.toml`: las fotos seguirán viéndose por el proxy, solo que sin R2.
Paso 2: copiar las fotos a R2 (una sola vez)
Admin → Configuración → 📦 Fotos en Cloudflare R2 → Copiar todas las fotos a R2.
Va de 8 en 8 y te muestra el avance. Al final te dice si alguna no se pudo copiar.
Cómo funcionan las fotos ahora
Por qué no se veían: Google rompió el formato `uc?export=view`. Ya no se usa.
Proxy: cualquier link de Drive se muestra como `/img/drive/ID` desde tu Worker. El Worker la trae de Drive (formato `thumbnail`, y si falla, `lh3`), la guarda en caché 30 días y la copia sola a R2 la primera vez que alguien la ve.
Fotos nuevas: al subir desde Menú o Editar carta, se guardan directo en R2 (`/img/r2/...`), ya no dentro de la base D1.
Sin R2 conectado: todo sigue funcionando como antes (las subidas se guardan en D1).
Nuevo rol: Editor de carta
Usuarios → crear con rol Editor de carta.
Al entrar solo ve 🖼️ Editar carta: subir o pegar link de foto, quitar foto, cambiar nombre y descripción.
No puede cambiar precios, agotados, categorías, usuarios ni nada más (el servidor lo bloquea, no solo la pantalla).
El admin también tiene esta vista.
Carta pública rediseñada (`/menu.html`)
Base visual de Gemini (verde esmeralda + ámbar, Playfair + Montserrat), conectada a todo:
Secciones como botones grandes (salen de tus secciones del admin) + categorías como pastillas.
Tarjetas con foto grande; si no hay foto, un fondo de color con ícono.
Modo noche automático después de las 2 PM, con botón 🌙/☀️.
Comanda separada por Barra y Cocina, con cantidades y 📝 nota por producto.
Notas separadas: las de cocina llegan solo a cocina y las de barra solo a barra.
En el club (mesa/cancha) · A domicilio directo (con costo de envío) · Rappi · Uber Eats.
WhatsApp al admin en turno, seguimiento de entrega y link a la tarjeta de lealtad al terminar.
Frase de bienvenida y horario editables en Configuración → Carta pública.
D1
No tienes que correr SQL. El Worker agrega solo las configuraciones `menu_tagline` y `business_hours`.
Prueba rápida
Crea el bucket y despliega.
Abre `/menu.html`: las fotos de Drive ya deben verse.
Configuración → Copiar fotos a R2.
Crea un usuario Editor de carta, entra con él y cambia una foto.
Haz un pedido de prueba con una bebida y un platillo, con nota en cada estación.

---
v27.1 — Carta Gemini al 100 % + fotos confiables
Fecha: 25 de septiembre de 2026
Carta
Si una foto no carga, la tarjeta queda exactamente como el diseño de Gemini (etiqueta Barra/Cocina, nombre, descripción, precio). Ya no hay cuadros de color vacíos.
En celular vuelve a una columna con descripción visible, como en el diseño original.
Configuración → Mostrar fotos en la carta pública: apágalo y la carta queda 100 % estilo Gemini.
Fotos: 3 rutas antes de rendirse
Tu Worker (R2 o caché).
Drive `thumbnail`, pedido directo desde el celular del cliente.
Drive `lh3`, también directo.
🔍 Probar fotos de Drive
Configuración → 📦 Fotos → 🔍 Probar fotos de Drive te dice cuál de las 3 rutas funciona en tu Cloudflare.
📂 Subir fotos en lote (la forma más segura)
En Google Drive, selecciona la carpeta de fotos → Descargar (baja un .zip) → descomprímelo.
En Menú (o Editar carta) toca 📂 Subir fotos en lote y elige todas las fotos.
Se emparejan solas por nombre (ignora "de", tamaños y acentos). Corrige las que falten con el selector.
⬆️ Subir: quedan en R2 y ya no dependen de Drive.
