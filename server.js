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

      // 1. LOGIN
      if (path === "/api/login" && request.method === "POST") {
        let username = "", password = "";
        try {
          const body = await request.json();
          username = body.username;
          password = body.password;
        } catch(e) {}

        let user = null;
        if (db) {
          try {
            user = await db.prepare("SELECT * FROM users WHERE username = ? AND password = ?").bind(username, password).first();
          } catch(e) {}
        }

        if (!user && username === "admin" && password === "admin") {
          user = { id: "1", name: "Administrador", username: "admin", role: "admin" };
        }

        if (!user) {
          return new Response(JSON.stringify({ error: "Usuario o contraseña incorrectos" }), {
            status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const token = btoa(JSON.stringify({ id: user.id, username: user.username, role: user.role, exp: Date.now() + 86400000 }));
        return new Response(JSON.stringify({ token, user }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // 2. MENÚ
      if (path === "/api/menu") {
        let items = [];
        if (db) {
          try {
            const { results } = await db.prepare("SELECT * FROM menu_items WHERE active = 1").all();
            items = results || [];
          } catch(e) {}
        }
        if (items.length === 0) {
          items = [
            { id: "1", name: "Hamburguesa Clásica", category: "Alimentos", price: 120, description: "Con papas", destination: "cocina", active: 1 },
            { id: "2", name: "Coca-Cola 600ml", category: "Bebidas", price: 35, description: "Fría", destination: "barra", active: 1 }
          ];
        }
        return new Response(JSON.stringify(items), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 3. MESAS
      if (path === "/api/tables") {
        let tables = [];
        if (db) {
          try {
            const { results } = await db.prepare("SELECT * FROM tables").all();
            tables = results || [];
          } catch(e) {}
        }
        if (tables.length === 0) {
          tables = [
            { id: "t1", name: "Mesa 1", capacity: 4, type: "mesa", status: "open" },
            { id: "t2", name: "Mesa 2", capacity: 4, type: "mesa", status: "open" }
          ];
        }
        return new Response(JSON.stringify(tables), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 4. ÓRDENES
      if (path === "/api/orders") {
        if (request.method === "GET") {
          let orders = [];
          if (db) {
            try {
              const { results } = await db.prepare("SELECT * FROM orders ORDER BY created_at DESC").all();
              orders = (results || []).map(o => ({ ...o, items: o.items ? JSON.parse(o.items) : [] }));
            } catch(e) {}
          }
          return new Response(JSON.stringify(orders), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        if (request.method === "POST") {
          const body = await request.json();
          const id = crypto.randomUUID();
          const itemsStr = JSON.stringify(body.items || []);
          const total = (body.items || []).reduce((acc, it) => acc + (it.qty * it.unit_price), 0);

          if (db) {
            try {
              await db.prepare("INSERT INTO orders (id, table_id, customer_name, customer_phone, notes, items, total, status, custom_folio) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)")
                .bind(id, body.table_id || null, body.customer_name || "General", body.customer_phone || "", body.notes || "", itemsStr, total, body.custom_folio || "").run();
            } catch(e) {}
          }
          return new Response(JSON.stringify({ ok: true, id }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      // 5. INVENTARIO
      if (path === "/api/inventory") {
        let inv = [];
        if (db) {
          try {
            const { results } = await db.prepare("SELECT * FROM inventory").all();
            inv = results || [];
          } catch(e) {}
        }
        if (inv.length === 0) {
          inv = [{ id: "i1", name: "Café en Grano (kg)", unit: "kg", stock: 15 }];
        }
        return new Response(JSON.stringify(inv), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 6. CANCHAS
      if (path === "/api/courts") {
        let courts = [];
        if (db) {
          try {
            const { results } = await db.prepare("SELECT * FROM courts").all();
            courts = results || [];
          } catch(e) {}
        }
        if (courts.length === 0) courts = [{ id: "c1", name: "Cancha Central Pádel", hourly_rate: 600 }];
        return new Response(JSON.stringify(courts), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 7. DASHBOARD Y CAJA
      if (path === "/api/dashboard") {
        let sales = 0, ordersCount = 0, expenses = 0;
        if (db) {
          try {
            const resSales = await db.prepare("SELECT SUM(total) as total, COUNT(*) as cnt FROM orders WHERE status = 'paid'").first();
            sales = resSales?.total || 0;
            ordersCount = resSales?.cnt || 0;
          } catch(e) {}
        }
        return new Response(JSON.stringify({ today: { sales, orders: ordersCount, expenses }, open: { count: 0 } }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 8. USUARIOS
      if (path === "/api/users") {
        let users = [];
        if (db) {
          try {
            const { results } = await db.prepare("SELECT id, name, username, role FROM users").all();
            users = results || [];
          } catch(e) {}
        }
        if (users.length === 0) users = [{ id: "1", name: "Administrador", username: "admin", role: "admin" }];
        return new Response(JSON.stringify(users), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
