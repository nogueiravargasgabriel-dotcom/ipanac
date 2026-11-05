import { createClient } from "npm:@supabase/supabase-js@2";

function corsHeaders(
  origin: string | null,
  requestedHeaders: string | null = null,
): Record<string, string> {
  const allowOrigin = origin || "*";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers":
      requestedHeaders ||
      "authorization, x-client-info, apikey, content-type, x-supabase-api-version, x-region",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
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
    return new Response("ok", {
      status: 200,
      headers: corsHeaders(
        origin,
        req.headers.get("Access-Control-Request-Headers"),
      ),
    });
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

    let body: { novaSenha?: unknown; senha_nova?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "JSON inválido." }, 400, origin);
    }

    // O app.js envia "senha_nova"; aceitamos também "novaSenha".
    const novaSenhaRaw = body.senha_nova ?? body.novaSenha;
    const novaSenha = typeof novaSenhaRaw === "string" ? novaSenhaRaw : "";

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