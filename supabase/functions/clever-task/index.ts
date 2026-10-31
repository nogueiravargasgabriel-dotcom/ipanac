import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://ipanac-nine.vercel.app",
]);

function makeCorsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };

  if (origin && ALLOWED_ORIGINS.has(origin)) {
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
      ...makeCorsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("Origin");
  const corsHeaders = makeCorsHeaders(origin);

  // O preflight precisa ser aceito antes de autenticação ou leitura do corpo.
  if (req.method === "OPTIONS") {
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return new Response("Origem não permitida.", {
        status: 403,
        headers: corsHeaders,
      });
    }

    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }

  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return jsonResponse({ error: "Origem não permitida." }, 403, origin);
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Método não permitido." }, 405, origin);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("NAC_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      console.error(
        "Configuração ausente: SUPABASE_URL ou NAC_SERVICE_ROLE_KEY.",
      );
      return jsonResponse(
        { error: "Configuração da função incompleta." },
        500,
        origin,
      );
    }

    const authorization = req.headers.get("Authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return jsonResponse(
        { error: "Sessão ausente ou inválida." },
        401,
        origin,
      );
    }

    const accessToken = authorization.slice("Bearer ".length).trim();

    if (!accessToken) {
      return jsonResponse(
        { error: "Token de sessão ausente." },
        401,
        origin,
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Confirma a identidade do usuário que chamou a função.
    const { data: authData, error: authError } =
      await supabaseAdmin.auth.getUser(accessToken);

    if (authError || !authData.user) {
      console.error("Falha ao validar sessão:", authError?.message);
      return jsonResponse(
        { error: "Sessão inválida ou expirada." },
        401,
        origin,
      );
    }

    // A autorização é conferida no banco, não em dados enviados pelo navegador.
    const { data: adminProfile, error: profileError } = await supabaseAdmin
      .from("usuarios")
      .select("id, role")
      .eq("id", authData.user.id)
      .maybeSingle();

    if (profileError) {
      console.error("Falha ao consultar perfil:", profileError.message);
      return jsonResponse(
        { error: "Não foi possível verificar a permissão do usuário." },
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

    let body: {
      nome?: unknown;
      email?: unknown;
      senha?: unknown;
    };

    try {
      body = await req.json();
    } catch {
      return jsonResponse(
        { error: "O corpo da requisição deve ser JSON válido." },
        400,
        origin,
      );
    }

    const nome = typeof body.nome === "string" ? body.nome.trim() : "";
    const email = typeof body.email === "string"
      ? body.email.trim().toLowerCase()
      : "";
    const senha = typeof body.senha === "string" ? body.senha : "";

    if (!nome || nome.length > 120) {
      return jsonResponse(
        { error: "Informe um nome de até 120 caracteres." },
        400,
        origin,
      );
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailPattern.test(email)) {
      return jsonResponse(
        { error: "Informe um endereço de e-mail válido." },
        400,
        origin,
      );
    }

    if (senha.length < 8) {
      return jsonResponse(
        { error: "A senha deve ter pelo menos 8 caracteres." },
        400,
        origin,
      );
    }

    // Cria a conta no Supabase Auth.
    const { data: createdAuth, error: createAuthError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password: senha,
        email_confirm: true,
        user_metadata: { nome },
      });

    if (createAuthError || !createdAuth.user) {
      console.error("Falha ao criar usuário Auth:", createAuthError?.message);
      return jsonResponse(
        {
          error: createAuthError?.message ||
            "Não foi possível criar a conta do educador.",
        },
        400,
        origin,
      );
    }

    const newUser = createdAuth.user;

    // O upsert também funciona quando um trigger já criou o perfil.
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
      console.error(
        "Falha ao salvar perfil do educador:",
        profileSaveError?.message,
      );

      // Rollback para não deixar uma conta Auth sem o perfil correspondente.
      const { error: deleteError } =
        await supabaseAdmin.auth.admin.deleteUser(newUser.id);

      if (deleteError) {
        console.error(
          "Falha ao remover conta após erro no perfil:",
          deleteError.message,
        );
      }

      return jsonResponse(
        {
          error: profileSaveError?.message ||
            "Não foi possível salvar o perfil do educador.",
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
  } catch (error) {
    console.error("Erro inesperado na Edge Function:", error);

    return jsonResponse(
      { error: "Erro inesperado ao cadastrar o educador." },
      500,
      origin,
    );
  }
});
