// RUSH POS v24.3 - Cloudflare Worker + D1
const ROLES = ["admin", "mesero", "cocina", "barra"];
const SESSION_MS = 24 * 60 * 60 * 1000;
let sessionsReady = false;
let menuSchemaReady = false;

// Estructura inicial del menú (tipo Starbucks: 2 secciones y categorías por "cómo lo pide el cliente")
const DEFAULT_SECTIONS = [
  { id: "sec_alimentos", name: "Alimentos", icon: "🍳", destination: "cocina", sort: 1 },
  { id: "sec_bebidas", name: "Bebidas", icon: "☕", destination: "barra", sort: 2 },
];
const DEFAULT_CATEGORIES = [
  ["cat_desayunos", "sec_alimentos", "Desayunos", 1],
  ["cat_tacos", "sec_alimentos", "Tacos y antojitos", 2],
  ["cat_hamburguesas", "sec_alimentos", "Hamburguesas y sándwiches", 3],
  ["cat_ensaladas", "sec_alimentos", "Ensaladas y bowls", 4],
  ["cat_botanas", "sec_alimentos", "Botanas y para compartir", 5],
  ["cat_postres", "sec_alimentos", "Postres y panadería", 6],
  ["cat_cafe_caliente", "sec_bebidas", "Café caliente", 1],
  ["cat_cafe_frio", "sec_bebidas", "Café frío", 2],
  ["cat_te", "sec_bebidas", "Té e infusiones", 3],
  ["cat_frappes", "sec_bebidas", "Frappés y licuados", 4],
  ["cat_jugos", "sec_bebidas", "Jugos y aguas frescas", 5],
  ["cat_refrescos", "sec_bebidas", "Refrescos, agua e hidratación", 6],
  ["cat_cervezas", "sec_bebidas", "Cervezas y micheladas", 7],
  ["cat_cocteles", "sec_bebidas", "Cocteles y licores", 8],
];

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => new Uint8Array(h.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
const safeEq = (a, b) => {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};
async function hashPw(pw, saltHex) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations: 100000 }, key, 256
  );
  return "pbkdf2$" + toHex(bits);
}
const newSalt = () => toHex(crypto.getRandomValues(new Uint8Array(16)));

// Notas: JSON {type,cocina,barra}. También lee el formato viejo de texto.
function parseNotes(s) {
  try {
    const o = JSON.parse(s);
    if (o && typeof o === "object") return { type: o.type || "", cocina: o.cocina || "", barra: o.barra || "" };
  } catch (e) {}
  const str = String(s || "");
  const g = (re) => { const m = str.match(re); const v = m ? m[1].trim() : ""; return v === "N/A" ? "" : v; };
  return { type: (str.match(/^\[([^\]]+)\]/) || [])[1] || "", cocina: g(/Cocina:\s*([^|]*)/), barra: g(/Barra:\s*([^|]*)/) };
}
function mergeNotes(curRaw, add) {
  const c = parseNotes(curRaw);
  const j = (a, b) => (b ? (a ? a + " / " + b : b) : a);
  return JSON.stringify({
    type: c.type || add.type || "",
    cocina: j(c.cocina, String(add.cocina || "").trim()),
    barra: j(c.barra, String(add.barra || "").trim()),
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // Archivos estáticos
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      const db = env.DB;
      if (!db) return json({ error: "Base de datos no disponible" }, 500);

      if (!sessionsReady) {
        await db.prepare(
          `CREATE TABLE IF NOT EXISTS pos_sessions (
             token TEXT PRIMARY KEY, user_id TEXT, username TEXT, name TEXT, role TEXT, expires_at INTEGER)`
        ).run();
        sessionsReady = true;
      }

      if (!menuSchemaReady) {
        // Tablas propias (prefijo pos_) para no chocar con tablas del sistema anterior
        await db.prepare(
          `CREATE TABLE IF NOT EXISTS pos_menu_sections (
             id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT DEFAULT '', destination TEXT NOT NULL DEFAULT 'cocina', sort_order INTEGER DEFAULT 0)`
        ).run();
        await db.prepare(
          `CREATE TABLE IF NOT EXISTS pos_menu_categories (
             id TEXT PRIMARY KEY, section_id TEXT NOT NULL, name TEXT NOT NULL, sort_order INTEGER DEFAULT 0)`
        ).run();
        try { await db.prepare("ALTER TABLE menu_items ADD COLUMN category_id TEXT").run(); } catch (e) {}
        for (const sec of DEFAULT_SECTIONS)
          await db.prepare("INSERT OR IGNORE INTO pos_menu_sections (id,name,icon,destination,sort_order) VALUES (?,?,?,?,?)")
            .bind(sec.id, sec.name, sec.icon, sec.destination, sec.sort).run();
        const have = await db.prepare("SELECT COUNT(*) AS c FROM pos_menu_categories").first();
        if (!have || !have.c)
          for (const [id, sid, name, sort] of DEFAULT_CATEGORIES)
            await db.prepare("INSERT OR IGNORE INTO pos_menu_categories (id,section_id,name,sort_order) VALUES (?,?,?,?)")
              .bind(id, sid, name, sort).run();
        menuSchemaReady = true;
      }

      const calcTotal = (items) =>
        items.reduce((s, i) => s + (Number(i.qty) || 1) * (Number(i.unit_price) || 0), 0);
      const parseOrder = (r) => ({ ...r, items: JSON.parse(r.items || "[]"), np: parseNotes(r.notes) });

      // ===== LOGIN (único endpoint sin sesión) =====
      if (path === "/api/login" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const username = String(b.username || "").trim();
        const password = String(b.password || "");

        let user = null, legacy = false;
        if (username) {
          let u = null;
          try {
            u = await db.prepare("SELECT * FROM users WHERE lower(username)=lower(?) AND active=1").bind(username).first();
          } catch (e) {}
          if (u) {
            if (String(u.password_hash || "").startsWith("pbkdf2$")) {
              const h = await hashPw(password, u.password_salt);
              if (safeEq(h, u.password_hash)) user = u;
            } else legacy = true;
          }
        }
        // Respaldo temporal: se apaga solo cuando exista un administrador con contraseña nueva
        if (!user && username === "admin" && password === "admin") {
          let allowed = true;
          try {
            const r = await db.prepare(
              "SELECT COUNT(*) AS c FROM users WHERE role='admin' AND active=1 AND password_hash LIKE 'pbkdf2$%'"
            ).first();
            allowed = (r?.c || 0) === 0;
          } catch (e) {}
          if (allowed) user = { id: "fallback", name: "Administrador", username: "admin", role: "admin" };
        }
        if (!user) {
          return json({
            error: legacy
              ? "Este usuario es anterior al sistema nuevo. Pide al administrador que le restablezca la contraseña."
              : "Usuario o contraseña incorrectos",
          }, 401);
        }

        await db.prepare("DELETE FROM pos_sessions WHERE expires_at < ?").bind(Date.now()).run();
        const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
        await db.prepare("INSERT INTO pos_sessions (token,user_id,username,name,role,expires_at) VALUES (?,?,?,?,?,?)")
          .bind(token, String(user.id), user.username, user.name, user.role, Date.now() + SESSION_MS).run();
        return json({ token, user: { id: user.id, name: user.name, username: user.username, role: user.role } });
      }

      // ===== Sesión obligatoria para todo lo demás =====
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const sess = token
        ? await db.prepare("SELECT * FROM pos_sessions WHERE token=? AND expires_at>?").bind(token, Date.now()).first()
        : null;
      if (!sess) return json({ error: "Sesión expirada. Inicia sesión de nuevo." }, 401);
      const isAdmin = sess.role === "admin";

      if (path === "/api/logout" && request.method === "POST") {
        await db.prepare("DELETE FROM pos_sessions WHERE token=?").bind(token).run();
        return json({ ok: true });
      }

      // ===== USUARIOS (solo admin) =====
      const um = path.match(/^\/api\/users(?:\/([^\/]+))?$/);
      if (um) {
        if (!isAdmin) return json({ error: "Solo el administrador puede gestionar usuarios" }, 403);
        const uid = um[1] ? decodeURIComponent(um[1]) : null;
        const otherAdmins = async (excludeId) => {
          const r = await db.prepare(
            "SELECT COUNT(*) AS c FROM users WHERE role='admin' AND active=1 AND id != ?"
          ).bind(excludeId).first();
          return r?.c || 0;
        };

        if (!uid && request.method === "GET") {
          const { results } = await db.prepare(
            "SELECT id, username, name, role, active, created_at, password_hash FROM users ORDER BY name"
          ).all();
          return json((results || []).map(({ password_hash, ...u }) => ({
            ...u, legacy: !String(password_hash || "").startsWith("pbkdf2$"),
          })));
        }

        if (!uid && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const name = String(b.name || "").trim();
          const username = String(b.username || "").trim();
          const password = String(b.password || "");
          const role = String(b.role || "mesero");
          if (!name || !username) return json({ error: "Nombre y usuario son obligatorios" }, 400);
          if (password.length < 4) return json({ error: "La contraseña debe tener al menos 4 caracteres" }, 400);
          if (!ROLES.includes(role)) return json({ error: "Rol no válido" }, 400);
          const dup = await db.prepare("SELECT id FROM users WHERE lower(username)=lower(?)").bind(username).first();
          if (dup) return json({ error: "Ese usuario ya existe" }, 409);
          const salt = newSalt();
          const hash = await hashPw(password, salt);
          const id = crypto.randomUUID();
          await db.prepare(
            `INSERT INTO users (id, username, name, role, password_hash, password_salt, active, created_at, updated_at, approved)
             VALUES (?,?,?,?,?,?,1,datetime('now'),datetime('now'),1)`
          ).bind(id, username, name, role, hash, salt).run();
          return json({ id }, 201);
        }

        if (uid && request.method === "PATCH") {
          const target = await db.prepare("SELECT * FROM users WHERE id=?").bind(uid).first();
          if (!target) return json({ error: "Usuario no encontrado" }, 404);
          const b = await request.json().catch(() => ({}));
          const sets = [], vals = [];
          if (typeof b.name === "string" && b.name.trim()) { sets.push("name=?"); vals.push(b.name.trim()); }
          if (b.role !== undefined) {
            if (!ROLES.includes(b.role)) return json({ error: "Rol no válido" }, 400);
            if (target.role === "admin" && b.role !== "admin" && (await otherAdmins(uid)) === 0)
              return json({ error: "No puedes quitar el rol al único administrador" }, 400);
            sets.push("role=?"); vals.push(b.role);
          }
          if (b.active !== undefined) {
            const a = b.active ? 1 : 0;
            if (!a && target.role === "admin" && (await otherAdmins(uid)) === 0)
              return json({ error: "No puedes desactivar al único administrador" }, 400);
            sets.push("active=?"); vals.push(a);
          }
          let passChanged = false;
          if (b.password !== undefined) {
            if (String(b.password).length < 4) return json({ error: "La contraseña debe tener al menos 4 caracteres" }, 400);
            const salt = newSalt();
            sets.push("password_hash=?", "password_salt=?");
            vals.push(await hashPw(String(b.password), salt), salt);
            passChanged = true;
          }
          if (!sets.length) return json({ error: "Nada que actualizar" }, 400);
          await db.prepare(`UPDATE users SET ${sets.join(", ")}, updated_at=datetime('now') WHERE id=?`)
            .bind(...vals, uid).run();
          if (passChanged || b.active === false || b.active === 0)
            await db.prepare("DELETE FROM pos_sessions WHERE user_id=? AND token != ?").bind(uid, token).run();
          return json({ ok: true });
        }

        if (uid && request.method === "DELETE") {
          if (uid === sess.user_id) return json({ error: "No puedes eliminar tu propio usuario" }, 400);
          const target = await db.prepare("SELECT * FROM users WHERE id=?").bind(uid).first();
          if (!target) return json({ error: "Usuario no encontrado" }, 404);
          if (target.role === "admin" && target.active && (await otherAdmins(uid)) === 0)
            return json({ error: "No puedes eliminar al único administrador" }, 400);
          await db.prepare("DELETE FROM users WHERE id=?").bind(uid).run();
          await db.prepare("DELETE FROM pos_sessions WHERE user_id=?").bind(uid).run();
          return json({ ok: true });
        }
      }

      // ===== CLIENTES (se arman con los datos de las órdenes) =====
      if (path === "/api/customers" && request.method === "GET") {
        const { results } = await db.prepare(
          `SELECT o.customer_phone AS phone,
                  (SELECT o2.customer_name FROM orders o2
                    WHERE o2.customer_phone = o.customer_phone ORDER BY o2.created_at DESC LIMIT 1) AS name,
                  COUNT(*) AS visits,
                  COALESCE(SUM(CASE WHEN o.status='paid' THEN o.total ELSE 0 END),0) AS spent,
                  MAX(o.created_at) AS last_visit
             FROM orders o
            WHERE o.customer_phone IS NOT NULL AND TRIM(o.customer_phone) != ''
            GROUP BY o.customer_phone
            ORDER BY last_visit DESC`
        ).all();
        return json((results || []).map((c) => ({
          ...c, name: String(c.name || "").replace(/\s*\(\d{10}\)\s*$/, "").trim() || "Cliente",
        })));
      }

      // ===== MENÚ =====
      const DESTS = ["cocina", "barra"];
      const needAdmin = () => (isAdmin ? null : json({ error: "Solo el administrador puede editar el menú" }, 403));
      const newId = (p) => p + "_" + crypto.randomUUID().slice(0, 8);

      // Mueve items de comandas abiertas cuando cambia la estación de un producto
      const moveOpenOrderItems = async (ids, dest) => {
        if (!ids.length) return;
        const idSet = new Set(ids.map(String));
        const { results } = await db.prepare("SELECT id, items FROM orders WHERE status != 'paid'").all();
        for (const o of results || []) {
          let items;
          try { items = JSON.parse(o.items || "[]"); } catch (e) { continue; }
          let changed = false;
          items = items.map((i) => {
            if (idSet.has(String(i.menu_item_id)) && (i.destination || "cocina") !== dest) {
              changed = true;
              return { ...i, destination: dest, done: false };
            }
            return i;
          });
          if (!changed) continue;
          const status = items.every((i) => i.done) ? "ready" : items.some((i) => i.done) ? "preparing" : "open";
          await db.prepare("UPDATE orders SET items=?, status=?, updated_at=datetime('now') WHERE id=?")
            .bind(JSON.stringify(items), status, o.id).run();
        }
      };
      // Pone categoría (y por ende estación) a un conjunto de productos
      const assignCategory = async (productIds, catId) => {
        const cat = await db.prepare(
          `SELECT c.id, c.name, s.destination FROM pos_menu_categories c JOIN pos_menu_sections s ON s.id=c.section_id WHERE c.id=?`
        ).bind(catId).first();
        if (!cat) return false;
        for (const pid of productIds)
          await db.prepare("UPDATE menu_items SET category_id=?, category=?, destination=? WHERE id=?")
            .bind(cat.id, cat.name, cat.destination, pid).run();
        await moveOpenOrderItems(productIds, cat.destination);
        return true;
      };
      const idsInCategories = async (catIds) => {
        if (!catIds.length) return [];
        const q = catIds.map(() => "?").join(",");
        const { results } = await db.prepare(`SELECT id FROM menu_items WHERE category_id IN (${q})`).bind(...catIds).all();
        return (results || []).map((r) => r.id);
      };

      if (path === "/api/menu" && request.method === "GET") {
        let items = [];
        try {
          const { results } = await db.prepare("SELECT * FROM menu_items WHERE active = 1 ORDER BY sort_order, name").all();
          items = results || [];
        } catch (e) {}
        return json(items);
      }

      if (path === "/api/menu-structure" && request.method === "GET") {
        const secs = (await db.prepare("SELECT * FROM pos_menu_sections ORDER BY sort_order, name").all()).results || [];
        const cats = (await db.prepare("SELECT * FROM pos_menu_categories ORDER BY sort_order, name").all()).results || [];
        return json({ sections: secs.map((sc) => ({ ...sc, categories: cats.filter((c) => c.section_id === sc.id) })) });
      }

      // Lo más pedido en los últimos 30 días (como "Destacados" de Starbucks)
      if (path === "/api/menu-popular" && request.method === "GET") {
        const { results } = await db.prepare("SELECT items FROM orders WHERE created_at >= datetime('now','-30 day')").all();
        const tally = {};
        for (const o of results || []) {
          let its; try { its = JSON.parse(o.items || "[]"); } catch (e) { continue; }
          for (const i of its) if (i.menu_item_id) tally[i.menu_item_id] = (tally[i.menu_item_id] || 0) + (Number(i.qty) || 1);
        }
        return json(Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, qty]) => ({ id, qty })));
      }

      if (path === "/api/menu" && request.method === "POST") {
        const deny = needAdmin(); if (deny) return deny;
        const b = await request.json().catch(() => ({}));
        const name = String(b.name || "").trim();
        const price = Number(b.price);
        if (!name) return json({ error: "El nombre es obligatorio" }, 400);
        if (!(price >= 0)) return json({ error: "El precio no es válido" }, 400);
        const dup = await db.prepare("SELECT id FROM menu_items WHERE active=1 AND lower(trim(name))=lower(?)").bind(name).first();
        if (dup) return json({ error: "Ya existe un producto con ese nombre" }, 409);
        let dest = DESTS.includes(b.destination) ? b.destination : "cocina";
        let catText = String(b.category || "").trim() || "General";
        let catId = null;
        if (b.category_id) {
          const cat = await db.prepare(
            "SELECT c.id, c.name, s.destination FROM pos_menu_categories c JOIN pos_menu_sections s ON s.id=c.section_id WHERE c.id=?"
          ).bind(b.category_id).first();
          if (!cat) return json({ error: "Categoría no encontrada" }, 404);
          catId = cat.id; catText = cat.name; dest = cat.destination;
        }
        const id = crypto.randomUUID();
        await db.prepare(
          "INSERT INTO menu_items (id, name, category, category_id, price, description, destination, active, sort_order) VALUES (?,?,?,?,?,?,?,1,0)"
        ).bind(id, name, catText, catId, price, String(b.description || ""), dest).run();
        return json({ id }, 201);
      }

      // Clasificar muchos productos a la vez: {assignments:[{id, category_id}]}
      if (path === "/api/menu-classify" && request.method === "POST") {
        const deny = needAdmin(); if (deny) return deny;
        const b = await request.json().catch(() => ({}));
        const byCat = {};
        for (const a of b.assignments || []) if (a.id && a.category_id) (byCat[a.category_id] ||= []).push(a.id);
        let n = 0;
        for (const [catId, ids] of Object.entries(byCat)) if (await assignCategory(ids, catId)) n += ids.length;
        return json({ ok: true, updated: n });
      }

      const mm = path.match(/^\/api\/menu\/([^\/]+)$/);
      if (mm && request.method === "PATCH") {
        const deny = needAdmin(); if (deny) return deny;
        const pid = decodeURIComponent(mm[1]);
        const cur = await db.prepare("SELECT * FROM menu_items WHERE id=?").bind(pid).first();
        if (!cur) return json({ error: "Producto no encontrado" }, 404);
        const b = await request.json().catch(() => ({}));
        const sets = [], vals = [];
        if (typeof b.name === "string" && b.name.trim()) { sets.push("name=?"); vals.push(b.name.trim()); }
        if (typeof b.description === "string") { sets.push("description=?"); vals.push(b.description); }
        if (b.price !== undefined && Number(b.price) >= 0) { sets.push("price=?"); vals.push(Number(b.price)); }
        if (b.active !== undefined) { sets.push("active=?"); vals.push(b.active ? 1 : 0); }
        if (b.destination !== undefined) {
          if (!DESTS.includes(b.destination)) return json({ error: "Estación no válida" }, 400);
          sets.push("destination=?"); vals.push(b.destination);
        }
        if (sets.length) await db.prepare(`UPDATE menu_items SET ${sets.join(", ")} WHERE id=?`).bind(...vals, pid).run();
        if (b.destination !== undefined) await moveOpenOrderItems([pid], b.destination);
        if (b.category_id) { if (!(await assignCategory([pid], b.category_id))) return json({ error: "Categoría no encontrada" }, 404); }
        if (!sets.length && !b.category_id) return json({ error: "Nada que actualizar" }, 400);
        return json({ ok: true });
      }

      // ----- Secciones -----
      if (path === "/api/menu-sections" && request.method === "POST") {
        const deny = needAdmin(); if (deny) return deny;
        const b = await request.json().catch(() => ({}));
        const name = String(b.name || "").trim();
        if (!name) return json({ error: "El nombre es obligatorio" }, 400);
        const dest = DESTS.includes(b.destination) ? b.destination : "cocina";
        const mx = await db.prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM pos_menu_sections").first();
        const id = newId("sec");
        await db.prepare("INSERT INTO pos_menu_sections (id,name,icon,destination,sort_order) VALUES (?,?,?,?,?)")
          .bind(id, name, String(b.icon || "🍽️"), dest, (mx?.m || 0) + 1).run();
        return json({ id }, 201);
      }
      const sm = path.match(/^\/api\/menu-sections\/([^\/]+)$/);
      if (sm && request.method === "PATCH") {
        const deny = needAdmin(); if (deny) return deny;
        const sid = decodeURIComponent(sm[1]);
        const cur = await db.prepare("SELECT * FROM pos_menu_sections WHERE id=?").bind(sid).first();
        if (!cur) return json({ error: "Sección no encontrada" }, 404);
        const b = await request.json().catch(() => ({}));
        const sets = [], vals = [];
        if (typeof b.name === "string" && b.name.trim()) { sets.push("name=?"); vals.push(b.name.trim()); }
        if (typeof b.icon === "string" && b.icon.trim()) { sets.push("icon=?"); vals.push(b.icon.trim()); }
        if (b.destination !== undefined) {
          if (!DESTS.includes(b.destination)) return json({ error: "Estación no válida" }, 400);
          sets.push("destination=?"); vals.push(b.destination);
        }
        if (!sets.length) return json({ error: "Nada que actualizar" }, 400);
        await db.prepare(`UPDATE pos_menu_sections SET ${sets.join(", ")} WHERE id=?`).bind(...vals, sid).run();
        if (b.destination !== undefined && b.destination !== cur.destination) {
          // toda la sección cambia de estación (ej. Bebidas -> barra)
          const cats = ((await db.prepare("SELECT id FROM pos_menu_categories WHERE section_id=?").bind(sid).all()).results || []).map((c) => c.id);
          const ids = await idsInCategories(cats);
          if (ids.length) {
            const q = ids.map(() => "?").join(",");
            await db.prepare(`UPDATE menu_items SET destination=? WHERE id IN (${q})`).bind(b.destination, ...ids).run();
            await moveOpenOrderItems(ids, b.destination);
          }
        }
        return json({ ok: true });
      }
      if (sm && request.method === "DELETE") {
        const deny = needAdmin(); if (deny) return deny;
        const sid = decodeURIComponent(sm[1]);
        const n = await db.prepare("SELECT COUNT(*) AS c FROM pos_menu_categories WHERE section_id=?").bind(sid).first();
        if (n?.c) return json({ error: "Primero elimina o mueve las categorías de esta sección" }, 400);
        await db.prepare("DELETE FROM pos_menu_sections WHERE id=?").bind(sid).run();
        return json({ ok: true });
      }

      // ----- Categorías -----
      if (path === "/api/menu-categories" && request.method === "POST") {
        const deny = needAdmin(); if (deny) return deny;
        const b = await request.json().catch(() => ({}));
        const name = String(b.name || "").trim();
        if (!name) return json({ error: "El nombre es obligatorio" }, 400);
        const sec = await db.prepare("SELECT id FROM pos_menu_sections WHERE id=?").bind(b.section_id).first();
        if (!sec) return json({ error: "Sección no encontrada" }, 404);
        const dup = await db.prepare("SELECT id FROM pos_menu_categories WHERE section_id=? AND lower(trim(name))=lower(?)").bind(sec.id, name).first();
        if (dup) return json({ error: "Esa categoría ya existe en la sección" }, 409);
        const mx = await db.prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM pos_menu_categories WHERE section_id=?").bind(sec.id).first();
        const id = newId("cat");
        await db.prepare("INSERT INTO pos_menu_categories (id,section_id,name,sort_order) VALUES (?,?,?,?)")
          .bind(id, sec.id, name, (mx?.m || 0) + 1).run();
        return json({ id }, 201);
      }
      const cm = path.match(/^\/api\/menu-categories\/([^\/]+)$/);
      if (cm && request.method === "PATCH") {
        const deny = needAdmin(); if (deny) return deny;
        const cid = decodeURIComponent(cm[1]);
        const cur = await db.prepare("SELECT * FROM pos_menu_categories WHERE id=?").bind(cid).first();
        if (!cur) return json({ error: "Categoría no encontrada" }, 404);
        const b = await request.json().catch(() => ({}));
        if (typeof b.name === "string" && b.name.trim()) {
          await db.prepare("UPDATE pos_menu_categories SET name=? WHERE id=?").bind(b.name.trim(), cid).run();
          await db.prepare("UPDATE menu_items SET category=? WHERE category_id=?").bind(b.name.trim(), cid).run();
        }
        if (b.section_id && b.section_id !== cur.section_id) {
          const sec = await db.prepare("SELECT * FROM pos_menu_sections WHERE id=?").bind(b.section_id).first();
          if (!sec) return json({ error: "Sección no encontrada" }, 404);
          await db.prepare("UPDATE pos_menu_categories SET section_id=? WHERE id=?").bind(sec.id, cid).run();
          const ids = await idsInCategories([cid]);
          if (ids.length) {
            await db.prepare("UPDATE menu_items SET destination=? WHERE category_id=?").bind(sec.destination, cid).run();
            await moveOpenOrderItems(ids, sec.destination);
          }
        }
        return json({ ok: true });
      }
      if (cm && request.method === "DELETE") {
        const deny = needAdmin(); if (deny) return deny;
        const cid = decodeURIComponent(cm[1]);
        // los productos quedan "sin clasificar" (no se borran)
        await db.prepare("UPDATE menu_items SET category_id=NULL WHERE category_id=?").bind(cid).run();
        await db.prepare("DELETE FROM pos_menu_categories WHERE id=?").bind(cid).run();
        return json({ ok: true });
      }

      // ===== MESAS =====
      if (path === "/api/tables" && request.method === "GET") {
        let tables = [];
        try {
          const { results } = await db.prepare("SELECT * FROM tables WHERE active = 1").all();
          tables = results || [];
        } catch (e) {}
        if (tables.length === 0) tables = [{ id: "t1", name: "Mesa 1", capacity: 4, type: "mesa", status: "open" }];
        return json(tables);
      }

      // ===== ÓRDENES =====
      const m = path.match(/^\/api\/orders(?:\/([^\/]+))?(?:\/(payments))?$/);
      if (m) {
        const id = m[1], sub = m[2];

        if (!id && request.method === "GET") {
          const { results } = await db.prepare("SELECT * FROM orders WHERE status != 'paid' ORDER BY created_at DESC").all();
          return json(results.map(parseOrder));
        }

        if (!id && request.method === "POST") {
          const b = await request.json();
          const items = (b.items || []).map(({ done, ...i }) => i);
          const total = calcTotal(items);
          const newId = crypto.randomUUID();
          const notes = b.notes && typeof b.notes === "object" ? JSON.stringify(b.notes) : String(b.notes || "");
          await db.prepare(
            `INSERT INTO orders (id, custom_folio, table_id, customer_name, customer_phone, notes, items, subtotal, total, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`
          ).bind(newId, b.custom_folio || null, b.table_id || null, b.customer_name || "Mostrador",
                 b.customer_phone || "", notes, JSON.stringify(items), total, total).run();
          return json({ id: newId }, 201);
        }

        if (id && sub === "payments" && request.method === "POST") {
          const o = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
          if (!o) return json({ error: "Orden no encontrada" }, 404);
          let method = "efectivo";
          try { const b = await request.json(); if (b.method) method = b.method; } catch (e) {}
          await db.batch([
            db.prepare(
              `INSERT INTO payments (order_id, method, amount, cash_amount, card_amount, terminal_amount, created_by)
               VALUES (?,?,?,?,?,0,?)`
            ).bind(id, method, o.total, method === "efectivo" ? o.total : 0, method === "tarjeta" ? o.total : 0, sess.username),
            db.prepare(
              `UPDATE orders SET status='paid', payment_status='paid', payment_method=?,
               closed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
            ).bind(method, id),
          ]);
          return json({ ok: true, paid: o.total });
        }

        if (id && !sub && request.method === "GET") {
          const o = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
          return o ? json(parseOrder(o)) : json({ error: "No encontrada" }, 404);
        }

        // Actualizar: status, items, notes, add_items/add_notes (agregar a la misma comanda), ready (cocina|barra)
        if (id && !sub && request.method === "PATCH") {
          const b = await request.json();
          const cur = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
          if (!cur) return json({ error: "No encontrada" }, 404);
          let items = JSON.parse(cur.items || "[]");
          let notes = cur.notes;
          let itemsChanged = false;
          if (Array.isArray(b.items)) { items = b.items; itemsChanged = true; }
          if (Array.isArray(b.add_items) && b.add_items.length) {
            items = items.concat(b.add_items.map(({ done, ...i }) => i));
            itemsChanged = true;
          }
          if (b.add_notes && (String(b.add_notes.cocina || "").trim() || String(b.add_notes.barra || "").trim()))
            notes = mergeNotes(cur.notes, b.add_notes);
          if (typeof b.notes === "string") notes = b.notes;
          if (b.ready === "cocina" || b.ready === "barra") {
            items = items.map((i) => ((i.destination || "cocina") === b.ready ? { ...i, done: true } : i));
            itemsChanged = true;
          }
          let status = b.status || cur.status;
          if (itemsChanged && !b.status) {
            const allDone = items.length > 0 && items.every((i) => i.done);
            status = allDone ? "ready" : items.some((i) => i.done) ? "preparing" : "open";
          }
          const total = calcTotal(items);
          await db.prepare("UPDATE orders SET status=?, items=?, subtotal=?, total=?, notes=?, updated_at=datetime('now') WHERE id=?")
            .bind(status, JSON.stringify(items), total, total, notes, id).run();
          return json({ ok: true, status });
        }

        if (id && !sub && request.method === "DELETE") {
          if (!isAdmin) return json({ error: "Solo el administrador puede borrar órdenes" }, 403);
          await db.prepare("DELETE FROM orders WHERE id=?").bind(id).run();
          return json({ ok: true });
        }
      }

      // ===== DASHBOARD (mínimo) =====
      if (path === "/api/dashboard" && request.method === "GET") {
        let sales = 0, orders = 0;
        try {
          const r = await db.prepare(
            `SELECT COALESCE(SUM(total),0) AS s, COUNT(*) AS c FROM orders
             WHERE status='paid' AND date(closed_at)=date('now')`
          ).first();
          sales = r?.s || 0; orders = r?.c || 0;
        } catch (e) {}
        return json({ today: { sales, orders, expenses: 0 } });
      }

      // ===== Aún no implementados =====
      if (request.method === "GET") return json([]);
      return json({ ok: true });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
