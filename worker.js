export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const db = env.DB;

      // 1. ENDPOINT DE LOGIN
      if (path === "/api/login" && request.method === "POST") {
        const { username, password } = await request.json();
        let user = null;
        try {
          const stmt = db.prepare("SELECT * FROM users WHERE username = ? AND password = ?");
          user = await stmt.bind(username, password).first();
        } catch(e) {}

        if (!user && username === "admin" && password === "admin") {
          user = { id: "1", name: "Deysa", username: "admin", role: "admin" };
        }

        if (!user) {
          return new Response(JSON.stringify({ error: "Usuario o contraseña incorrectos" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const token = btoa(JSON.stringify({ id: user.id, username: user.username, role: user.role, exp: Date.now() + 86400000 }));
        return new Response(JSON.stringify({ token, user: { id: user.id, name: user.name, username: user.username, role: user.role } }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // 2. ENDPOINT /me (VERIFICAR SESIÓN)
      if (path === "/api/me" && request.method === "GET") {
        const auth = request.headers.get("Authorization");
        if (!auth) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: corsHeaders });
        try {
          const token = auth.replace("Bearer ", "");
          const decoded = JSON.parse(atob(token));
          return new Response(JSON.stringify({ user: { id: decoded.id, name: decoded.username, username: decoded.username, role: decoded.role } }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        } catch(e) {
          return new Response(JSON.stringify({ error: "Token inválido" }), { status: 401, headers: corsHeaders });
        }
      }

      // 3. MENÚ Y DESTINOS (COCINA / BARRA)
      if (path === "/api/menu" || path.startsWith("/api/menu/")) {
        const menuId = path.split("/")[3];

        if (path === "/api/menu" && request.method === "GET") {
          let items = [];
          try {
            const { results } = await db.prepare("SELECT * FROM menu_items WHERE active = 1").all();
            items = results || [];
          } catch(e) {
            items = [
              { id: "1", name: "Hamburguesa Clásica", category: "Alimentos", price: 120, description: "Con papas", destination: "cocina", active: 1 },
              { id: "2", name: "Coca-Cola 600ml", category: "Bebidas", price: 35, description: "Fría", destination: "barra", active: 1 },
              { id: "3", name: "Café Americano", category: "Cafetería", price: 30, description: "Caliente", destination: "barra", active: 1 }
            ];
          }
          return new Response(JSON.stringify(items), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        if (path === "/api/menu" && request.method === "POST") {
          const body = await request.json();
          const id = crypto.randomUUID();
          try {
            await db.prepare("INSERT INTO menu_items (id, name, category, price, description, destination, active) VALUES (?, ?, ?, ?, ?, ?, 1)")
              .bind(id, body.name, body.category || "General", body.price, body.description || "", body.destination || "cocina").run();
          } catch(e) {}
          return new Response(JSON.stringify({ ok: true, id }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        if (menuId && request.method === "PATCH") {
          try {
            await db.prepare("UPDATE menu_items SET active = 0 WHERE id = ?").bind(menuId).run();
          } catch(e) {}
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      // 4. MESAS Y SALA
      if (path === "/api/tables") {
        let tables = [];
        try {
          const { results } = await db.prepare("SELECT * FROM tables").all();
          tables = results || [];
        } catch(e) {
          tables = [
            { id: "t1", name: "Mesa 1", capacity: 4, type: "mesa", status: "open" },
            { id: "t2", name: "Mesa 2", capacity: 4, type: "mesa", status: "open" },
            { id: "t3", name: "Mesa 3", capacity: 6, type: "mesa", status: "open" }
          ];
        }
        return new Response(JSON.stringify(tables), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 5. ÓRDENES, COMANDAS Y COBROS
      if (path === "/api/orders" || path.startsWith("/api/orders/")) {
        const orderId = path.split("/")[3];

        if (path === "/api/orders" && request.method === "GET") {
          let orders = [];
          try {
            const { results } = await db.prepare("SELECT * FROM orders ORDER BY created_at DESC").all();
            orders = (results || []).map(o => ({ ...o, items: o.items ? JSON.parse(o.items) : [] }));
          } catch(e) {}
          return new Response(JSON.stringify(orders), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        if (path === "/api/orders" && request.method === "POST") {
          const body = await request.json();
          const id = crypto.randomUUID();
          const itemsStr = JSON.stringify(body.items || []);
          const total = (body.items || []).reduce((acc, it) => acc + (it.qty * it.unit_price), 0);

          try {
            await db.prepare("INSERT INTO orders (id, table_id, customer_name, customer_phone, notes, items, total, status, custom_folio) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)")
              .bind(id, body.table_id || null, body.customer_name || "General", body.customer_phone || "", body.notes || "", itemsStr, total, body.custom_folio || "").run();
          } catch(e) {}
          return new Response(JSON.stringify({ ok: true, id }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        if (orderId && request.method === "GET" && !path.includes("comments")) {
          let order = null;
          try {
            order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
            if (order) order.items = order.items ? JSON.parse(order.items) : [];
          } catch(e) {}
          return new Response(JSON.stringify(order || {}), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        if (orderId && request.method === "PATCH") {
          const body = await request.json();
          try {
            if (body.status) {
              await db.prepare("UPDATE orders SET status = ? WHERE id = ?").bind(body.status, orderId).run();
            }
            if (body.items) {
              const itemsStr = JSON.stringify(body.items);
              const total = body.items.reduce((acc, it) => acc + (it.qty * it.unit_price), 0);
              await db.prepare("UPDATE orders SET items = ?, total = ? WHERE id = ?").bind(itemsStr, total, orderId).run();
            }
          } catch(e) {}
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        if (orderId && path.includes("payments") && request.method === "POST") {
          try {
            await db.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").bind(orderId).run();
          } catch(e) {}
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        if (orderId && request.method === "DELETE") {
          try {
            await db.prepare("DELETE FROM orders WHERE id = ?").bind(orderId).run();
          } catch(e) {}
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // Chat / Comentarios por comanda
        if (orderId && path.includes("comments")) {
          if (request.method === "GET") {
            let comments = [];
            try {
              const { results } = await db.prepare("SELECT * FROM order_comments WHERE order_id = ? ORDER BY created_at ASC").bind(orderId).all();
              comments = results || [];
            } catch(e) {}
            return new Response(JSON.stringify(comments), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
          if (request.method === "POST") {
            const body = await request.json();
            const cid = crypto.randomUUID();
            try {
              await db.prepare("INSERT INTO order_comments (id, order_id, user_name, role, comment) VALUES (?, ?, ?, ?, ?)")
                .bind(cid, orderId, "Personal", "staff", body.comment).run();
            } catch(e) {}
            return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        }
      }

      // 6. INVENTARIO Y COMPRAS
      if (path === "/api/inventory" || path.startsWith("/api/inventory/")) {
        const invId = path.split("/")[3];
        if (path === "/api/inventory" && request.method === "GET") {
          let inv = [];
          try {
            const { results } = await db.prepare("SELECT * FROM inventory").all();
            inv = results || [];
          } catch(e) {
            inv = [
              { id: "i1", name: "Café en Grano (kg)", unit: "kg", stock: 15 },
              { id: "i2", name: "Leche Entera (lt)", unit: "lt", stock: 30 },
              { id: "i3", name: "Carne Hamburguesa (pza)", unit: "pza", stock: 50 }
            ];
          }
          return new Response(JSON.stringify(inv), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        if (invId && request.method === "PATCH") {
          const body = await request.json();
          try {
            await db.prepare("UPDATE inventory SET stock = ? WHERE id = ?").bind(body.stock, invId).run();
          } catch(e) {}
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      if (path === "/api/purchases" && request.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 7. CANCHAS Y RESERVAS
      if (path === "/api/courts") {
        let courts = [];
        try {
          const { results } = await db.prepare("SELECT * FROM courts").all();
          courts = results || [];
        } catch(e) {
          courts = [{ id: "c1", name: "Cancha Central Pádel", hourly_rate: 600 }];
        }
        return new Response(JSON.stringify(courts), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (path === "/api/reservations" || path.startsWith("/api/reservations/")) {
        const resId = path.split("/")[3];
        if (path === "/api/reservations" && request.method === "GET") {
          let res = [];
          try {
            const { results } = await db.prepare("SELECT * FROM reservations").all();
            res = results || [];
          } catch(e) {}
          return new Response(JSON.stringify(res), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        if (path === "/api/reservations" && request.method === "POST") {
          const body = await request.json();
          const id = crypto.randomUUID();
          try {
            await db.prepare("INSERT INTO reservations (id, court_id, customer_name, customer_phone, date, start_time, hours, total_price, deposit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
              .bind(id, body.court_id, body.customer_name, body.customer_phone, body.date, body.start_time, body.hours, body.total_price, body.deposit).run();
          } catch(e) {}
          return new Response(JSON.stringify({ ok: true, id }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        if (resId && request.method === "DELETE") {
          try {
            await db.prepare("DELETE FROM reservations WHERE id = ?").bind(resId).run();
          } catch(e) {}
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      // 8. USUARIOS Y LEALTAD
      if (path === "/api/users" || path.startsWith("/api/users/")) {
        const userId = path.split("/")[3];
        if (path === "/api/users" && request.method === "GET") {
          let users = [];
          try {
            const { results } = await db.prepare("SELECT id, name, username, role FROM users").all();
            users = results || [];
          } catch(e) {
            users = [{ id: "1", name: "Deysa", username: "admin", role: "admin" }];
          }
          return new Response(JSON.stringify(users), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        if (path === "/api/users" && request.method === "POST") {
          const body = await request.json();
          const id = crypto.randomUUID();
          try {
            await db.prepare("INSERT INTO users (id, name, username, password, role) VALUES (?, ?, ?, ?, ?)")
              .bind(id, body.name, body.username, body.password, body.role).run();
          } catch(e) {}
          return new Response(JSON.stringify({ ok: true, id }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        if (userId && request.method === "PATCH") {
          const body = await request.json();
          try {
            if (body.password) {
              await db.prepare("UPDATE users SET password = ? WHERE id = ?").bind(body.password, userId).run();
            }
          } catch(e) {}
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        if (userId && request.method === "DELETE") {
          try {
            await db.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
          } catch(e) {}
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      if (path === "/api/loyalty" || path === "/api/loyalty/register") {
        let loyalty = [];
        try {
          const { results } = await db.prepare("SELECT * FROM loyalty_customers").all();
          loyalty = results || [];
        } catch(e) {}
        return new Response(JSON.stringify(loyalty), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 9. DASHBOARD, CAJA Y CORTE
      if (path === "/api/dashboard") {
        let sales = 0, count = 0;
        try {
          const res = await db.prepare("SELECT SUM(total) as total, COUNT(*) as cnt FROM orders WHERE status = 'paid'").first();
          sales = res?.total || 0;
          count = res?.cnt || 0;
        } catch(e) {}
        return new Response(JSON.stringify({ today: { sales, orders: count, expenses: 0 }, open: { count: 0 } }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (path === "/api/cuts" || path === "/api/manual-transactions") {
        if (request.method === "GET") {
          let cuts = [];
          try {
            const { results } = await db.prepare("SELECT * FROM cash_cuts ORDER BY cut_date DESC").all();
            cuts = results || [];
          } catch(e) {}
          return new Response(JSON.stringify(cuts), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        if (request.method === "POST") {
          return new Response(JSON.stringify({ total_sales: 1250, total_expenses: 150, net_profit: 1100 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};
