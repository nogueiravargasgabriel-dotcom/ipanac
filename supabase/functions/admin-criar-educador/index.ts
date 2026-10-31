import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders,
  });
}

Deno.serve(async (req: Request) => {
  // O navegador envia OPTIONS antes do POST. Responda sem exigir autenticação.
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Método não permitido." }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("NAC_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      console.error("Faltam SUPABASE_URL ou NAC_SERVICE_ROLE_KEY nos secrets.");
      return jsonResponse({ error: "Configuração da função incompleta." }, 500);
    }

    const authorization = req.headers.get("Authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return jsonResponse({ error: "Sessão ausente ou inválida." }, 401);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    const token = authorization.slice("Bearer ".length);
    const { data: authData, error: authError } =
      await adminClient.auth.getUser(token);

    if (authError || !authData.user) {
      return jsonResponse({ error: "Sessão inválida ou expirada." }, 401);
    }

    const { data: profile, error: profileError } = await adminClient
      .from("usuarios")
      .select("role")
      .eq("id", authData.user.id)
      .maybeSingle();

    if (profileError) {
      console.error("Falha ao consultar perfil:", profileError.message);
      return jsonResponse({ error: "Não foi possível verificar a permissão." }, 500);
    }

    if (profile?.role !== "admin") {
      return jsonResponse({ error: "Apenas o Admin Master pode criar educadores." }, 403);
    }

    let body: { nome?: unknown; email?: unknown; senha?: unknown };

    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "O corpo da requisição não é JSON válido." }, 400);
    }

    const nome = typeof body.nome === "string" ? body.nome.trim() : "";
    const email = typeof body.email === "string"
      ? body.email.trim().toLowerCase()
      : "";
    const senha = typeof body.senha === "string" ? body.senha : "";

    if (!nome || !email || senha.length < 8) {
      return jsonResponse({
        error: "Informe nome, e-mail válido e senha com pelo menos 8 caracteres.",
      }, 400);
    }

    const { data: created, error: createError } =
      await adminClient.auth.admin.createUser({
        email,
        password: senha,
        email_confirm: true,
        user_metadata: { nome },
      });

    if (createError || !created.user) {
      console.error("Falha ao criar usuário:", createError?.message);
      return jsonResponse({
        error: createError?.message || "Não foi possível criar a conta.",
      }, 400);
    }

    const { data: profileCreated, error: insertError } = await adminClient
      .from("usuarios")
      .insert({
        id: created.user.id,
        nome,
        email,
        role: "professor",
      })
      .select("id,nome,email,role")
      .single();

    if (insertError || !profileCreated) {
      console.error("Falha ao criar perfil:", insertError?.message);

      // Evita deixar uma conta Auth sem o perfil correspondente.
      const { error: rollbackError } =
        await adminClient.auth.admin.deleteUser(created.user.id);

      if (rollbackError) {
        console.error("Falha ao desfazer criação da conta:", rollbackError.message);
      }

      return jsonResponse({
        error: insertError?.message || "Não foi possível criar o perfil do educador.",
      }, 500);
    }

    return jsonResponse({
      user: {
        id: profileCreated.id,
        nome: profileCreated.nome,
        email: profileCreated.email,
        role: profileCreated.role,
      },
    });
  } catch (error) {
    console.error("Erro inesperado:", error);
    return jsonResponse({ error: "Erro inesperado ao criar educador." }, 500);
  }
});