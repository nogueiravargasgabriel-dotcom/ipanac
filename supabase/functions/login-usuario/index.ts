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

const USERNAME_PATTERN = /^[a-z0-9._-]{3,40}$/;

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
      "Cache-Control": "no-store",
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
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !serviceRoleKey || !anonKey) {
      console.error("Faltam variáveis de ambiente do Supabase.");
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

    const usuario = typeof body.usuario === "string"
      ? body.usuario.trim().toLowerCase()
      : "";
    const senha = typeof body.senha === "string" ? body.senha : "";

    if (!USERNAME_PATTERN.test(usuario) || !senha || senha.length > 128) {
      return jsonResponse(
        { error: "Usuário ou senha inválidos." },
        400,
        origin,
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("usuarios")
      .select("id, nome, usuario, role")
      .eq("usuario", usuario)
      .maybeSingle();

    if (profileError) {
      console.error("Erro ao procurar perfil:", profileError);
      return jsonResponse(
        { error: "Não foi possível validar o acesso." },
        500,
        origin,
      );
    }

    if (!profile) {
      return jsonResponse(
        { error: "Usuário ou senha inválidos." },
        401,
        origin,
      );
    }

    const { data: authUserResult, error: authUserError } =
      await supabaseAdmin.auth.admin.getUserById(profile.id);

    const authEmail = authUserResult.user?.email;

    if (authUserError || !authEmail) {
      console.error("Conta Auth sem e-mail associado:", authUserError);
      return jsonResponse(
        { error: "A conta ainda não está configurada para entrar." },
        401,
        origin,
      );
    }

    const supabaseAuth = createClient(supabaseUrl, anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    const { data: signInData, error: signInError } =
      await supabaseAuth.auth.signInWithPassword({
        email: authEmail,
        password: senha,
      });

    if (signInError || !signInData.session || !signInData.user) {
      return jsonResponse(
        { error: "Usuário ou senha inválidos." },
        401,
        origin,
      );
    }

    const mustChangePassword =
      signInData.user.app_metadata?.must_change_password === true ||
      signInData.user.user_metadata?.must_change_password === true;

    return jsonResponse(
      {
        session: signInData.session,
        user: {
          id: profile.id,
          nome: profile.nome,
          usuario: profile.usuario,
          role: profile.role,
        },
        must_change_password: mustChangePassword,
      },
      200,
      origin,
    );
  } catch (error: unknown) {
    console.error(
      "Erro inesperado na função de login:",
      error instanceof Error ? error.message : String(error),
    );

    return jsonResponse(
      { error: "Ocorreu um erro inesperado ao entrar." },
      500,
      origin,
    );
  }
});