# RUSH POS v4 — Cloudflare

Sistema POS para RUSH con frontend estático + Cloudflare Worker + D1.

## Incluye
- Punto de venta
- Mesas y canchas
- Carrito y modificadores
- Notas para cocina
- Pantalla de cocina
- Caja y pagos
- Dashboard y ventas del día
- Persistencia en Cloudflare D1
- API REST en Worker

## Deploy
1. Crea una base D1 llamada `rush-pos`.
2. Copia su ID a `wrangler.toml`.
3. Ejecuta:
   `npx wrangler d1 execute rush-pos --remote --file=schema.sql`
4. Carga el menú:
   `npx wrangler d1 execute rush-pos --remote --file=seed.sql`
5. Publica:
   `npx wrangler deploy`

En Cloudflare Pages/Workers, si ya tienes un proyecto creado, asegúrate de que el repositorio contiene `worker.js`, `wrangler.toml` y la carpeta `public/`.

## Importante
El archivo `wrangler.toml` contiene un placeholder para el `database_id`. No lo dejes así al hacer el deploy real.
