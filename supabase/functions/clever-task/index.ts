import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set([
  "https://ipanac-nine.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5500",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5500",
]);

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };

  if (origin && allowedOrigins.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  origin: string | null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("Origin");
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    if (origin && !allowedOrigins.has(origin)) {
      return new Response("Origem não permitida.", {
        status: 403,
        headers,
      });
    }

    return new Response("ok", { status: 200, headers });
  }

  if (origin && !allowedOrigins.has(origin)) {
    return jsonResponse({ error: "Origem não permitida." }, 403, origin);
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Método não permitido." }, 405, origin);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
      Deno.env.get("NAC_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      console.error(
        "Faltam as variáveis SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY.",
      );
      return jsonResponse(
        { error: "Configuração da função incompleta no Supabase." },
        500,
        origin,
      );
    }

    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) {
      return jsonResponse({ error: "Sessão ausente ou inválida." }, 401, origin);
    }

    const accessToken = authorization.slice("Bearer ".length).trim();
    if (!accessToken) {
      return jsonResponse({ error: "Token de sessão ausente." }, 401, origin);
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    const { data: authData, error: authError } =
      await supabaseAdmin.auth.getUser(accessToken);

    if (authError || !authData.user) {
      return jsonResponse({ error: "Sessão inválida ou expirada." }, 401, origin);
    }

    const { data: adminProfile, error: profileError } = await supabaseAdmin
      .from("usuarios")
      .select("id, role")
      .eq("id", authData.user.id)
      .maybeSingle();

    if (profileError) {
      console.error("Erro ao consultar perfil do administrador:", profileError);
      return jsonResponse(
        { error: `Erro ao checar perfil: ${profileError.message}` },
        500,
        origin,
      );
    }

    if (adminProfile?.role !== "admin") {
      return jsonResponse(
        { error: "Apenas o Admin Master pode cadastrar educadores." },
        403,
        origin,
      );
    }

    let body: { nome?: unknown; email?: unknown; senha?: unknown };

    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "JSON inválido." }, 400, origin);
    }

    const nome = typeof body.nome === "string" ? body.nome.trim() : "";
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const senha = typeof body.senha === "string" ? body.senha : "";

    if (!nome || nome.length > 120) {
      return jsonResponse(
        { error: "Informe um nome de até 120 caracteres." },
        400,
        origin,
      );
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse({ error: "Informe um e-mail válido." }, 400, origin);
    }

    if (senha.length < 8) {
      return jsonResponse(
        { error: "A senha deve ter pelo menos 8 caracteres." },
        400,
        origin,
      );
    }

    const { data: createdAuth, error: createAuthError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password: senha,
        email_confirm: true,
        user_metadata: { nome },
      });

    if (createAuthError || !createdAuth.user) {
      return jsonResponse(
        {
          error:
            createAuthError?.message ||
            "Não foi possível criar a conta Auth.",
        },
        400,
        origin,
      );
    }

    const newUser = createdAuth.user;

    const { data: profile, error: profileSaveError } = await supabaseAdmin
      .from("usuarios")
      .upsert(
        {
          id: newUser.id,
          nome,
          email,
          role: "professor",
        },
        { onConflict: "id" },
      )
      .select("id, nome, email, role")
      .single();

    if (profileSaveError || !profile) {
      console.error("Erro ao salvar public.usuarios:", profileSaveError);

      // Rollback intencional: evita deixar uma conta Auth sem perfil correspondente.
      const { error: rollbackError } =
        await supabaseAdmin.auth.admin.deleteUser(newUser.id);

      if (rollbackError) {
        console.error("Falha ao remover conta Auth órfã:", rollbackError);
      }

      return jsonResponse(
        {
          error: `Erro ao salvar o perfil na tabela usuarios: ${
            profileSaveError?.message ?? "nenhum perfil retornado"
          }`,
        },
        500,
        origin,
      );
    }

    return jsonResponse(
      {
        user: {
          id: profile.id,
          nome: profile.nome,
          email: profile.email,
          role: profile.role,
        },
      },
      200,
      origin,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Erro inesperado na Edge Function:", message);

    return jsonResponse(
      { error: `Erro inesperado: ${message}` },
      500,
      origin,
    );
  }
});
