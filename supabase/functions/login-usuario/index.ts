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

  // O navegador envia OPTIONS antes do POST. Deve receber status 2xx.
  if (req.method === "OPTIONS") {
    if (origin && !allowedOrigins.has(origin)) {
      return new Response("Origem não permitida.", {
        status: 403,
        headers,
      });
    }

    return new Response("ok", {
      status: 200,
      headers,
    });
  }

  if (origin && !allowedOrigins.has(origin)) {
    return jsonResponse({ error: "Origem não permitida." }, 403, origin);
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Método não permitido." }, 405, origin);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      console.error(
        "Configuração ausente: SUPABASE_URL, SUPABASE_ANON_KEY ou SUPABASE_SERVICE_ROLE_KEY.",
      );

      return jsonResponse(
        { error: "Configuração da função incompleta no Supabase." },
        500,
        origin,
      );
    }

    let body: { usuario?: unknown; senha?: unknown };

    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "JSON inválido." }, 400, origin);
    }

    const usuario =
      typeof body.usuario === "string"
        ? body.usuario.trim().toLowerCase()
        : "";

    const senha = typeof body.senha === "string" ? body.senha : "";

    if (!usuario || !senha) {
      return jsonResponse(
        { error: "Informe o usuário e a senha." },
        400,
        origin,
      );
    }

    if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) {
      return jsonResponse(
        { error: "Usuário ou senha inválidos." },
        401,
        origin,
      );
    }

    // A service role é usada somente no servidor para localizar o perfil.
    // Nunca coloque essa chave no app.js ou em arquivos públicos do site.
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("usuarios")
      .select("id,nome,usuario,role")
      .ilike("usuario", usuario)
      .maybeSingle();

    if (profileError) {
      console.error("Erro ao consultar perfil pelo usuário:", profileError);

      return jsonResponse(
        { error: "Não foi possível validar o usuário." },
        500,
        origin,
      );
    }

    // Resposta genérica para não revelar se o usuário existe.
    if (!profile) {
      return jsonResponse(
        { error: "Usuário ou senha inválidos." },
        401,
        origin,
      );
    }

    // As contas de Auth devem ter sido criadas com este e-mail técnico.
    const internalEmail = `${usuario}@login.invalid`;

    const supabaseAuth = createClient(supabaseUrl, anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    const { data: authData, error: authError } =
      await supabaseAuth.auth.signInWithPassword({
        email: internalEmail,
        password: senha,
      });

    if (authError || !authData.user || !authData.session) {
      return jsonResponse(
        { error: "Usuário ou senha inválidos." },
        401,
        origin,
      );
    }

    // Impede login caso o perfil público não corresponda à conta Auth.
    if (authData.user.id !== profile.id) {
      console.error(
        "O UUID do perfil usuarios não corresponde ao UUID da conta Auth.",
        { profileId: profile.id, authUserId: authData.user.id },
      );

      return jsonResponse(
        { error: "O perfil da conta está inconsistente. Contate o administrador." },
        403,
        origin,
      );
    }

    const mustChangePassword =
      authData.user.app_metadata?.must_change_password === true;

    return jsonResponse(
      {
        access_token: authData.session.access_token,
        refresh_token: authData.session.refresh_token,
        token_type: authData.session.token_type,
        expires_in: authData.session.expires_in,
        must_change_password: mustChangePassword,
        user: {
          id: profile.id,
          nome: profile.nome,
          usuario: profile.usuario,
          role: profile.role,
          must_change_password: mustChangePassword,
        },
      },
      200,
      origin,
    );
  } catch (error: unknown) {
    console.error(
      "Erro inesperado em login-usuario:",
      error instanceof Error ? error.message : String(error),
    );

    return jsonResponse(
      { error: "Ocorreu um erro inesperado durante o login." },
      500,
      origin,
    );
  }
});