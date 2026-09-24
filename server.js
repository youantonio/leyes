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
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (path === "/api/menu") {
        return new Response(JSON.stringify([
          { id: "1", name: "Hamburguesa Clásica", category: "Alimentos", price: 120, description: "Con papas", destination: "cocina", active: 1 },
          { id: "2", name: "Coca-Cola 600ml", category: "Bebidas", price: 35, description: "Fría", destination: "barra", active: 1 }
        ]), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (path === "/api/tables") {
        return new Response(JSON.stringify([
          { id: "t1", name: "Mesa 1", capacity: 4, type: "mesa", status: "open" }
        ]), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
