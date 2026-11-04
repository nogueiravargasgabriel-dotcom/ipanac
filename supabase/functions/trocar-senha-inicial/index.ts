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
      "Cache-Control": "no-store",
    },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("Origin");

  if (req.method === "OPTIONS") {
    if (origin && !allowedOrigins.has(origin)) {
      return new Response("Origem não permitida.", {
        status: 403,
        headers: corsHeaders(origin),
      });
    }

    return new Response("ok", {
      status: 200,
      headers: corsHeaders(origin),
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
    const serviceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
      Deno.env.get("NAC_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      console.error("Faltam variáveis de ambiente do Supabase.");
      return jsonResponse(
        { error: "Configuração da função incompleta." },
        500,
        origin,
      );
    }

    const authorization = req.headers.get("Authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return jsonResponse({ error: "Sessão ausente ou inválida." }, 401, origin);
    }

    const accessToken = authorization.slice("Bearer ".length).trim();

    let body: { novaSenha?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "JSON inválido." }, 400, origin);
    }

    const novaSenha =
      typeof body.novaSenha === "string" ? body.novaSenha : "";

    if (novaSenha.length < 8 || novaSenha.length > 128) {
      return jsonResponse(
        { error: "A nova senha deve ter entre 8 e 128 caracteres." },
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

    const { data: authData, error: authError } =
      await supabaseAdmin.auth.getUser(accessToken);

    if (authError || !authData.user) {
      return jsonResponse({ error: "Sessão inválida ou expirada." }, 401, origin);
    }

    const authUser = authData.user;
    const isRequired =
      authUser.app_metadata?.must_change_password === true ||
      authUser.user_metadata?.must_change_password === true;

    if (!isRequired) {
      return jsonResponse(
        { error: "Esta conta não está aguardando troca inicial de senha." },
        409,
        origin,
      );
    }

    const { error: updateError } =
      await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
        password: novaSenha,
        app_metadata: {
          ...authUser.app_metadata,
          must_change_password: false,
        },
        user_metadata: {
          ...authUser.user_metadata,
          must_change_password: false,
        },
      });

    if (updateError) {
      console.error("Erro ao atualizar senha:", updateError);
      return jsonResponse(
        { error: "Não foi possível atualizar a senha." },
        500,
        origin,
      );
    }

    return jsonResponse({ success: true }, 200, origin);
  } catch (error: unknown) {
    console.error(
      "Erro inesperado:",
      error instanceof Error ? error.message : String(error),
    );

    return jsonResponse(
      { error: "Ocorreu um erro inesperado." },
      500,
      origin,
    );
  }
});