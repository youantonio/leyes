export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
      try {
        const response = await api(request, env, url);
        return withCors(response);
      } catch (err) {
        console.error(err);
        return withCors(json({ error: err?.message || "Server error" }, 500));
      }
    }

    return env.ASSETS.fetch(request);
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function withCors(response) {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders()).forEach(([k,v]) => headers.set(k,v));
  return new Response(response.body, { status: response.status, headers });
}

function json(data, status=200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

async function body(request) {
  return await request.json().catch(() => ({}));
}

async function requireAuth(request, env, roles = []) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new Error("No autorizado");

  const session = await env.DB.prepare(`
    SELECT s.token, s.expires_at, u.id, u.name, u.username, u.role, u.active, u.approved
    FROM sessions s
    JOIN users u ON u.id=s.user_id
    WHERE s.token=? AND s.expires_at > datetime('now')
  `).bind(token).first();

  if (!session || !session.active || !session.approved) throw new Error("Sesión inválida o usuario no aprobado");
  if (roles.length && !roles.includes(session.role)) throw new Error("Permisos insuficientes");
  return session;
}

async function api(request, env, url) {
  const p = url.pathname.replace(/^\/api\/?/, "");
  const parts = p.split("/");
  const resource = parts[0];
  const id = parts[1];

  // Salud
  if (request.method === "GET" && resource === "health") {
    return json({ ok: true, service: "RUSH POS", time: new Date().toISOString() });
  }

  // Login
  if (request.method === "POST" && resource === "login") {
    const d = await body(request);
    const username = String(d.username || "").trim().toLowerCase();
    const password = String(d.password || "");
    if (!username || !password) return json({ error: "Usuario y contraseña son obligatorios." }, 400);

    const user = await env.DB.prepare(`
      SELECT id,name,username,role,active,approved,password_hash
      FROM users WHERE lower(username)=?
    `).bind(username).first();

    if (!user || !user.active || !user.approved) {
      return json({ error: "Usuario no encontrado, inactivo o pendiente de aprobación." }, 401);
    }

    // Nota: para mantener el proyecto simple en Cloudflare, las contraseñas iniciales
    // se comparan con SHA-256. En producción se recomienda migrar a un proveedor
    // de identidad o a un esquema de hash con salt.
    const hash = await sha256(password);
    if (hash !== user.password_hash) return json({ error: "Contraseña incorrecta." }, 401);

    const token = crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
    const expires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString().replace("T"," ").slice(0,19);

    await env.DB.prepare(`
      INSERT INTO sessions(token,user_id,expires_at,created_at)
      VALUES(?,?,?,datetime('now'))
    `).bind(token,user.id,expires).run();

    return json({
      token,
      user: { id:user.id, name:user.name, username:user.username, role:user.role }
    });
  }

  if (request.method === "POST" && resource === "logout") {
    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token=?").bind(token).run();
    return json({ ok:true });
  }

  // Sesión actual
  if (request.method === "GET" && resource === "me") {
    const me = await requireAuth(request, env);
    return json({ user: { id:me.id, name:me.name, username:me.username, role:me.role } });
  }

  // Usuarios: SOLO administrador crea/aprueba/desactiva.
  if (request.method === "GET" && resource === "users") {
    await requireAuth(request, env, ["admin"]);
    const rows = await env.DB.prepare(`
      SELECT id,name,username,role,active,approved,created_at
      FROM users ORDER BY name
    `).all();
    return json(rows.results);
  }

  if (request.method === "POST" && resource === "users") {
    await requireAuth(request, env, ["admin"]);
    const d = await body(request);
    const name = String(d.name || "").trim();
    const username = String(d.username || "").trim().toLowerCase();
    const password = String(d.password || "");
    const role = ["admin","waiter","cashier","kitchen"].includes(d.role) ? d.role : "waiter";

    if (!name || !username || !password) return json({ error:"Nombre, usuario y contraseña son obligatorios." },400);
    if (password.length < 6) return json({ error:"La contraseña debe tener al menos 6 caracteres." },400);

    const exists = await env.DB.prepare("SELECT id FROM users WHERE lower(username)=?").bind(username).first();
    if (exists) return json({ error:"Ese usuario ya existe." },409);

    const id = crypto.randomUUID();
    const hash = await sha256(password);
    await env.DB.prepare(`
      INSERT INTO users(id,name,username,password_hash,role,active,approved,created_at)
      VALUES(?,?,?,?,?,1,1,datetime('now'))
    `).bind(id,name,username,hash,role).run();

    return json({ ok:true, id },201);
  }

  if (request.method === "PATCH" && resource === "users" && id) {
    await requireAuth(request, env, ["admin"]);
    const d = await body(request);
    const sets = [], vals = [];

    if (d.name !== undefined) { sets.push("name=?"); vals.push(String(d.name).trim()); }
    if (d.role !== undefined && ["admin","waiter","cashier","kitchen"].includes(d.role)) { sets.push("role=?"); vals.push(d.role); }
    if (d.active !== undefined) { sets.push("active=?"); vals.push(d.active ? 1 : 0); }
    if (d.approved !== undefined) { sets.push("approved=?"); vals.push(d.approved ? 1 : 0); }
    if (d.password) { sets.push("password_hash=?"); vals.push(await sha256(String(d.password))); }

    if (!sets.length) return json({ error:"Sin cambios." },400);
    vals.push(id);
    await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id=?`).bind(...vals).run();
    return json({ ok:true });
  }

  // Catálogo
  if (request.method === "GET" && resource === "menu") {
    const rows = await env.DB.prepare(`
      SELECT * FROM menu_items WHERE active=1
      ORDER BY category, sort_order, name
    `).all();
    return json(rows.results);
  }

  if (request.method === "POST" && resource === "menu") {
    await requireAuth(request, env, ["admin"]);
    const d = await body(request);
    const item = {
      id: crypto.randomUUID(),
      name: String(d.name || "").trim(),
      category: String(d.category || "General").trim(),
      price: Number(d.price || 0),
      description: String(d.description || ""),
      active: 1,
      sort_order: Number(d.sort_order || 0)
    };
    if (!item.name) return json({error:"El producto necesita nombre."},400);
    await env.DB.prepare(`
      INSERT INTO menu_items(id,name,category,price,description,active,sort_order)
      VALUES(?,?,?,?,?,?,?)
    `).bind(item.id,item.name,item.category,item.price,item.description,item.active,item.sort_order).run();
    return json({ id:item.id },201);
  }

  // Mesas
  if (request.method === "GET" && resource === "tables") {
    await requireAuth(request, env, ["admin","waiter","cashier","kitchen"]);
    const rows = await env.DB.prepare("SELECT * FROM tables ORDER BY type, number").all();
    return json(rows.results);
  }

  // Órdenes
  if (request.method === "GET" && resource === "orders") {
    await requireAuth(request, env, ["admin","waiter","cashier","kitchen"]);
    const status = url.searchParams.get("status");
    let q = "SELECT o.*, u.name AS waiter_name FROM orders o LEFT JOIN users u ON u.id=o.waiter_id";
    const args = [];
    if (status) { q += " WHERE o.status=?"; args.push(status); }
    q += " ORDER BY o.created_at DESC LIMIT 200";
    const rows = await env.DB.prepare(q).bind(...args).all();
    return json(rows.results);
  }

  if (request.method === "GET" && resource === "orders" && id) {
    await requireAuth(request, env, ["admin","waiter","cashier","kitchen"]);
    const order = await env.DB.prepare(`
      SELECT o.*, u.name AS waiter_name
      FROM orders o LEFT JOIN users u ON u.id=o.waiter_id
      WHERE o.id=?
    `).bind(id).first();
    const items = await env.DB.prepare(
      "SELECT * FROM order_items WHERE order_id=? ORDER BY id"
    ).bind(id).all();
    return json({ order, items: items.results });
  }

  if (request.method === "POST" && resource === "orders") {
    const me = await requireAuth(request, env, ["admin","waiter","cashier"]);
    const data = await body(request);
    if (!data.items?.length) return json({ error: "La orden necesita al menos un producto." }, 400);

    const now = new Date().toISOString();
    const orderId = crypto.randomUUID();
    const subtotal = data.items.reduce((s, x) => s + Number(x.qty || 1) * Number(x.unit_price || 0), 0);
    const discount = Number(data.discount || 0);
    const total = Math.max(0, subtotal - discount);

    const stmts = [
      env.DB.prepare(`INSERT INTO orders
        (id,table_id,customer_name,notes,status,subtotal,discount,total,payment_status,waiter_id,created_at,updated_at)
        VALUES (?,?,?,?, 'open',?,?,?,'pending',?,?,?)`)
        .bind(orderId,data.table_id||null,data.customer_name||"",data.notes||"",subtotal,discount,total,me.id,now,now)
    ];

    for (const item of data.items) {
      stmts.push(env.DB.prepare(`INSERT INTO order_items
        (order_id,menu_item_id,name,qty,unit_price,modifiers,notes)
        VALUES (?,?,?,?,?,?,?)`)
        .bind(orderId,item.menu_item_id||null,item.name,Number(item.qty||1),
          Number(item.unit_price||0),JSON.stringify(item.modifiers||[]),item.notes||""));
    }

    await env.DB.batch(stmts);
    return json({ id:orderId,subtotal,discount,total,status:"open",waiter_id:me.id,waiter_name:me.name },201);
  }

  if (request.method === "PATCH" && resource === "orders" && id) {
    const me = await requireAuth(request, env, ["admin","waiter","cashier","kitchen"]);
    const data = await body(request);
    const allowed = ["status","payment_status","payment_method","notes","discount"];
    const sets=[], vals=[];
    for (const k of allowed) {
      if (data[k] !== undefined) { sets.push(`${k}=?`); vals.push(data[k]); }
    }
    if (data.payment_breakdown !== undefined) {
      sets.push("payment_breakdown=?");
      vals.push(JSON.stringify(data.payment_breakdown));
    }
    if (data.status === "paid" || data.payment_status === "paid") {
      sets.push("closed_at=?"); vals.push(new Date().toISOString());
    }
    if (!sets.length) return json({error:"Sin cambios."},400);
    sets.push("updated_at=?"); vals.push(new Date().toISOString());
    vals.push(id);
    await env.DB.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE id=?`).bind(...vals).run();
    return json({ok:true,updated_by:me.name});
  }

  // Dashboard
  if (request.method === "GET" && resource === "dashboard") {
    await requireAuth(request, env, ["admin","cashier"]);
    const today = new Date().toISOString().slice(0,10);
    const sales = await env.DB.prepare(
      "SELECT COALESCE(SUM(total),0) total, COUNT(*) orders FROM orders WHERE status='paid' AND substr(created_at,1,10)=?"
    ).bind(today).first();
    const open = await env.DB.prepare(
      "SELECT COUNT(*) count FROM orders WHERE status IN ('open','preparing','ready')"
    ).first();
    const kitchen = await env.DB.prepare(
      "SELECT COUNT(*) count FROM orders WHERE status IN ('open','preparing')"
    ).first();
    return json({sales,open,kitchen});
  }

  return json({ error:"Ruta no encontrada" },404);
}

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2,"0")).join("");
}
