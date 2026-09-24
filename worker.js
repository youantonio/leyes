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

      if (path === "/api/login" && request.method === "POST") {
        return new Response(JSON.stringify({ 
          token: "bypass_absoluto", 
          user: { id: "1", name: "Administrador Supremo", username: "admin", role: "admin" } 
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      if (path === "/api/me" && request.method === "GET") {
        return new Response(JSON.stringify({ 
          user: { id: "1", name: "Administrador Supremo", username: "admin", role: "admin" } 
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      if (path === "/api/menu") {
        const items = [
          { id: "1", name: "Hamburguesa Clásica", category: "Alimentos", price: 120, description: "Con papas", destination: "cocina", active: 1 },
          { id: "2", name: "Coca-Cola 600ml", category: "Bebidas", price: 35, description: "Fría", destination: "barra", active: 1 }
        ];
        return new Response(JSON.stringify(items), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (path === "/api/tables") {
        const tables = [
          { id: "t1", name: "Mesa 1", capacity: 4, type: "mesa", status: "open" },
          { id: "t2", name: "Mesa 2", capacity: 4, type: "mesa", status: "open" }
        ];
        return new Response(JSON.stringify(tables), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (path === "/api/orders" && request.method === "GET") {
        return new Response(JSON.stringify([]), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (path === "/api/orders" && request.method === "POST") {
        return new Response(JSON.stringify({ ok: true, id: "temp_id" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (path === "/api/dashboard") {
        return new Response(JSON.stringify({ today: { sales: 0, orders: 0, expenses: 0 }, open: { count: 0 } }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
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
