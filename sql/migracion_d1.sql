-- RUSH POS v24.1 - Cambios en D1 (base: rush-pos-db)
-- Ejecutar en la CONSOLA SQL del dashboard de Cloudflare, una sentencia a la vez.
-- Solo AGREGAN columnas; no borran nada. Si una ya existe, marcará "duplicate column": ignorar.

ALTER TABLE orders ADD COLUMN items TEXT DEFAULT '[]';
ALTER TABLE orders ADD COLUMN custom_folio TEXT;
ALTER TABLE menu_items ADD COLUMN destination TEXT DEFAULT 'cocina';

-- Opcional: mandar bebidas a barra (ajusta el nombre de la categoría)
-- SELECT DISTINCT category FROM menu_items;
-- UPDATE menu_items SET destination='barra' WHERE category='Bebidas';
