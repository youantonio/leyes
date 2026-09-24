// RUSH POS v24.3 - Cloudflare Worker + D1
const ROLES = ["admin", "mesero", "cocina", "barra"];
const SESSION_MS = 24 * 60 * 60 * 1000;
let sessionsReady = false;

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
      if (path === "/api/menu" && request.method === "GET") {
        let items = [];
        try {
          const { results } = await db.prepare("SELECT * FROM menu_items WHERE active = 1 ORDER BY sort_order, name").all();
          items = results || [];
        } catch (e) {}
        if (items.length === 0) {
          items = [
            { id: "1", name: "Hamburguesa Clásica", category: "Alimentos", price: 120, description: "Con papas", destination: "cocina", active: 1 },
            { id: "2", name: "Coca-Cola 600ml", category: "Bebidas", price: 35, description: "Fría", destination: "barra", active: 1 },
          ];
        }
        return json(items);
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
