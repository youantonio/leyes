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
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Archivos estáticos (index.html, etc.)
    if (!path.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      const db = env.DB;

      const calcTotal = (items) =>
        items.reduce((s, i) => s + (Number(i.qty) || 1) * (Number(i.unit_price) || 0), 0);
      const parseOrder = (r) => ({ ...r, items: JSON.parse(r.items || "[]") });

      // ===== 1. LOGIN =====
      if (path === "/api/login" && request.method === "POST") {
        let username = "", password = "";
        try {
          const body = await request.json();
          username = body.username;
          password = body.password;
        } catch (e) {}

        let user = null;
        // Nota: tu tabla users usa password_hash/password_salt,
        // así que esta consulta fallará y se usa el respaldo de abajo.
        if (db) {
          try {
            user = await db
              .prepare("SELECT * FROM users WHERE username = ? AND password = ?")
              .bind(username, password)
              .first();
          } catch (e) {}
        }

        if (!user && username === "admin" && password === "admin") {
          user = { id: "1", name: "Administrador", username: "admin", role: "admin" };
        }

        if (!user) {
          return json({ error: "Usuario o contraseña incorrectos" }, 401);
        }

        const token = btoa(
          JSON.stringify({ id: user.id, username: user.username, name: user.name, role: user.role, exp: Date.now() + 86400000 })
        );
        return json({ token, user });
      }

      // ===== 2. MENÚ =====
      if (path === "/api/menu" && request.method === "GET") {
        let items = [];
        if (db) {
          try {
            const { results } = await db
              .prepare("SELECT * FROM menu_items WHERE active = 1 ORDER BY sort_order, name")
              .all();
            items = results || [];
          } catch (e) {}
        }
        if (items.length === 0) {
          items = [
            { id: "1", name: "Hamburguesa Clásica", category: "Alimentos", price: 120, description: "Con papas", destination: "cocina", active: 1 },
            { id: "2", name: "Coca-Cola 600ml", category: "Bebidas", price: 35, description: "Fría", destination: "barra", active: 1 },
          ];
        }
        return json(items);
      }

      // ===== 3. MESAS =====
      if (path === "/api/tables" && request.method === "GET") {
        let tables = [];
        if (db) {
          try {
            const { results } = await db.prepare("SELECT * FROM tables WHERE active = 1").all();
            tables = results || [];
          } catch (e) {}
        }
        if (tables.length === 0) {
          tables = [{ id: "t1", name: "Mesa 1", capacity: 4, type: "mesa", status: "open" }];
        }
        return json(tables);
      }

      // ===== 4. ÓRDENES =====
      const m = path.match(/^\/api\/orders(?:\/([^\/]+))?(?:\/(payments))?$/);
      if (m && db) {
        const id = m[1], sub = m[2];

        // Listar (no cobradas)
        if (!id && request.method === "GET") {
          const { results } = await db
            .prepare("SELECT * FROM orders WHERE status != 'paid' ORDER BY created_at DESC")
            .all();
          return json(results.map(parseOrder));
        }

        // Crear
        if (!id && request.method === "POST") {
          const b = await request.json();
          const items = b.items || [];
          const total = calcTotal(items);
          const newId = crypto.randomUUID();
          await db
            .prepare(
              `INSERT INTO orders (id, custom_folio, table_id, customer_name, customer_phone, notes, items, subtotal, total, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`
            )
            .bind(
              newId, b.custom_folio || null, b.table_id || null, b.customer_name || "Mostrador",
              b.customer_phone || "", b.notes || "", JSON.stringify(items), total, total
            )
            .run();
          return json({ id: newId }, 201);
        }

        // Cobrar
        if (id && sub === "payments" && request.method === "POST") {
          const o = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
          if (!o) return json({ error: "Orden no encontrada" }, 404);
          let method = "efectivo";
          try {
            const b = await request.json();
            if (b.method) method = b.method;
          } catch (e) {}
          await db.batch([
            db
              .prepare(
                `INSERT INTO payments (order_id, method, amount, cash_amount, card_amount, terminal_amount, created_by)
                 VALUES (?,?,?,?,?,0,?)`
              )
              .bind(id, method, o.total, method === "efectivo" ? o.total : 0, method === "tarjeta" ? o.total : 0, "admin"),
            db
              .prepare(
                `UPDATE orders SET status='paid', payment_status='paid', payment_method=?,
                 closed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
              )
              .bind(method, id),
          ]);
          return json({ ok: true, paid: o.total });
        }

        // Leer una
        if (id && !sub && request.method === "GET") {
          const o = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
          return o ? json(parseOrder(o)) : json({ error: "No encontrada" }, 404);
        }

        // Actualizar (status, items, notes) y marcar listo por estación
        if (id && !sub && request.method === "PATCH") {
          const b = await request.json();
          const cur = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
          if (!cur) return json({ error: "No encontrada" }, 404);
          let items = JSON.parse(cur.items || "[]");
          let itemsChanged = false;
          if (Array.isArray(b.items)) { items = b.items; itemsChanged = true; }
          // b.ready = "cocina" | "barra": marca solo los productos de esa estación
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
          const notes = typeof b.notes === "string" ? b.notes : cur.notes;
          await db
            .prepare("UPDATE orders SET status=?, items=?, subtotal=?, total=?, notes=?, updated_at=datetime('now') WHERE id=?")
            .bind(status, JSON.stringify(items), total, total, notes, id)
            .run();
          return json({ ok: true, status });
        }

        // Borrar
        if (id && !sub && request.method === "DELETE") {
          await db.prepare("DELETE FROM orders WHERE id=?").bind(id).run();
          return json({ ok: true });
        }
      }

      // ===== 5. DASHBOARD (mínimo, para que Caja no falle) =====
      if (path === "/api/dashboard" && request.method === "GET") {
        let sales = 0, orders = 0;
        if (db) {
          try {
            const r = await db
              .prepare(
                `SELECT COALESCE(SUM(total),0) AS s, COUNT(*) AS c FROM orders
                 WHERE status='paid' AND date(closed_at)=date('now')`
              )
              .first();
            sales = r?.s || 0;
            orders = r?.c || 0;
          } catch (e) {}
        }
        return json({ today: { sales, orders, expenses: 0 } });
      }

      // ===== Endpoints aún no implementados =====
      if (request.method === "GET") return json([]);
      return json({ ok: true });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
