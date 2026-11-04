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

function corsHeaders(
  origin: string | null,
  requestedHeaders: string | null = null,
): Record<string, string> {
  const headers: Record<string, string> = {
    // Na pré-requisição (OPTIONS) devolvemos exatamente os cabeçalhos que o
    // navegador pediu. Assim, versões novas do supabase-js que enviem
    // cabeçalhos extras (x-region, x-supabase-api-version etc.) não quebram.
    "Access-Control-Allow-Headers":
      requestedHeaders ||
      "authorization, x-client-info, apikey, content-type, x-supabase-api-version, x-region",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
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
  const headers = corsHeaders(
    origin,
    req.headers.get("Access-Control-Request-Headers"),
  );

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
      console.error("Faltam variáveis de ambiente obrigatórias.");
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
      console.error("Erro ao consultar perfil:", profileError);
      return jsonResponse(
        { error: "Não foi possível validar o perfil do administrador." },
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

    let body: { nome?: unknown; usuario?: unknown; senha?: unknown };

    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "JSON inválido." }, 400, origin);
    }

    const nome = typeof body.nome === "string" ? body.nome.trim() : "";
    const usuario =
      typeof body.usuario === "string"
        ? body.usuario.trim().toLowerCase()
        : "";
    const senha = typeof body.senha === "string" ? body.senha : "";

    if (!nome || nome.length > 120) {
      return jsonResponse(
        { error: "Informe um nome de até 120 caracteres." },
        400,
        origin,
      );
    }

    if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) {
      return jsonResponse(
        {
          error:
            "O usuário deve ter de 3 a 40 caracteres: letras minúsculas, números, ponto, hífen ou sublinhado.",
        },
        400,
        origin,
      );
    }

    if (senha.length < 8) {
      return jsonResponse(
        { error: "A senha inicial deve ter pelo menos 8 caracteres." },
        400,
        origin,
      );
    }

    const { data: existingProfile, error: existingError } =
      await supabaseAdmin
        .from("usuarios")
        .select("id")
        .ilike("usuario", usuario)
        .maybeSingle();

    if (existingError) {
      console.error("Erro ao verificar usuário existente:", existingError);
      return jsonResponse(
        { error: "Não foi possível verificar se o usuário já existe." },
        500,
        origin,
      );
    }

    if (existingProfile) {
      return jsonResponse(
        { error: "Esse nome de usuário já está em uso." },
        409,
        origin,
      );
    }

    // E-mail interno usado somente pelo Supabase Auth.
    const internalEmail = `${usuario}@login.invalid`;

    const { data: createdAuth, error: createAuthError } =
      await supabaseAdmin.auth.admin.createUser({
        email: internalEmail,
        password: senha,
        email_confirm: true,
        user_metadata: { nome, usuario },
      });

    if (createAuthError || !createdAuth.user) {
      console.error("Erro ao criar conta Auth:", createAuthError);
      return jsonResponse(
        {
          error:
            createAuthError?.message ||
            "Não foi possível criar a conta do educador.",
        },
        400,
        origin,
      );
    }

    const newUser = createdAuth.user;

    const { error: metadataError } =
      await supabaseAdmin.auth.admin.updateUserById(newUser.id, {
        app_metadata: { must_change_password: true },
      });

    if (metadataError) {
      console.error("Erro ao marcar troca obrigatória:", metadataError);
      await supabaseAdmin.auth.admin.deleteUser(newUser.id);

      return jsonResponse(
        { error: "Não foi possível configurar a troca obrigatória de senha." },
        500,
        origin,
      );
    }

    const { data: profile, error: saveError } = await supabaseAdmin
      .from("usuarios")
      .insert({
        id: newUser.id,
        nome,
        usuario,
        email: null,
        role: "professor",
      })
      .select("id, nome, usuario, email, role")
      .single();

    if (saveError || !profile) {
      console.error("Erro ao salvar perfil:", saveError);

      const { error: rollbackError } =
        await supabaseAdmin.auth.admin.deleteUser(newUser.id);

      if (rollbackError) {
        console.error("Falha ao remover conta Auth órfã:", rollbackError);
      }

      if (saveError?.code === "23505") {
        return jsonResponse(
          { error: "Esse nome de usuário já está em uso." },
          409,
          origin,
        );
      }

      return jsonResponse(
        { error: "Não foi possível salvar o perfil do educador." },
        500,
        origin,
      );
    }

    return jsonResponse(
      {
        user: {
          id: profile.id,
          nome: profile.nome,
          usuario: profile.usuario,
          email: profile.email,
          role: profile.role,
        },
      },
      200,
      origin,
    );
  } catch (err: unknown) {
    console.error(
      "Erro inesperado em clever-task:",
      err instanceof Error ? err.message : String(err),
    );

    return jsonResponse(
      { error: "Ocorreu um erro inesperado ao cadastrar o educador." },
      500,
      origin,
    );
  }
});