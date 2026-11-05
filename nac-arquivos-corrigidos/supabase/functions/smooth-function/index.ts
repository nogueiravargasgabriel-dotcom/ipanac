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
    },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("Origin");
  const headers = corsHeaders(
    origin,
    req.headers.get("Access-Control-Request-Headers"),
  );

  // O navegador envia OPTIONS antes do POST (preflight CORS).
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers,
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Método não permitido." }, 405, origin);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey =
      Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("NAC_ANON_KEY");
    const serviceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
      Deno.env.get("NAC_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      const faltando = [
        !supabaseUrl && "SUPABASE_URL",
        !anonKey && "SUPABASE_ANON_KEY (ou NAC_ANON_KEY)",
        !serviceRoleKey && "SUPABASE_SERVICE_ROLE_KEY (ou NAC_SERVICE_ROLE_KEY)",
      ].filter(Boolean).join(", ");

      console.error("Variáveis de ambiente ausentes:", faltando);

      return jsonResponse(
        { error: `Configuração da função incompleta. Faltando: ${faltando}` },
        500,
        origin,
      );
    }

    let body: { usuario?: unknown; email?: unknown; senha?: unknown };

    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "JSON inválido." }, 400, origin);
    }

    const rawLogin = (
      typeof body.usuario === "string"
        ? body.usuario
        : typeof body.email === "string"
        ? body.email
        : ""
    ).trim();
    const senha = typeof body.senha === "string" ? body.senha : "";

    if (!rawLogin || !senha) {
      return jsonResponse(
        { error: "Informe o usuário (ou e-mail) e a senha." },
        400,
        origin,
      );
    }

    const isEmail = rawLogin.includes("@");
    const loginSanitized = rawLogin.toLowerCase();

    // Validação que aceita tanto username quanto email
    if (loginSanitized.length < 3 || loginSanitized.length > 100) {
      return jsonResponse(
        { error: "Usuário ou senha inválidos." },
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

    const supabaseAuth = createClient(supabaseUrl, anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // 1. Localiza o perfil na tabela usuarios por usuario OU por email
    let profile: {
      id: string;
      nome: string;
      usuario: string;
      email: string | null;
      role: string;
    } | null = null;

    if (isEmail) {
      const { data, error } = await supabaseAdmin
        .from("usuarios")
        .select("id,nome,usuario,email,role")
        .ilike("email", loginSanitized)
        .maybeSingle();

      if (!error && data) profile = data;
    }

    if (!profile) {
      const { data, error } = await supabaseAdmin
        .from("usuarios")
        .select("id,nome,usuario,email,role")
        .ilike("usuario", loginSanitized)
        .maybeSingle();

      if (!error && data) profile = data;
    }

    // 2. Determina o e-mail cadastrado no Supabase Auth
    let authEmail: string | null = null;

    if (profile) {
      try {
        const { data: adminUser } =
          await supabaseAdmin.auth.admin.getUserById(profile.id);
        if (adminUser?.user?.email) {
          authEmail = adminUser.user.email;
        }
      } catch (err) {
        console.warn("Aviso ao consultar Auth por UUID:", err);
      }
    }

    // Lista de possíveis e-mails para autenticar no Supabase Auth
    const candidateEmails: string[] = [];
    if (authEmail) candidateEmails.push(authEmail);
    if (profile?.email && !candidateEmails.includes(profile.email)) {
      candidateEmails.push(profile.email);
    }
    if (profile?.usuario) {
      const internal = `${profile.usuario.toLowerCase()}@login.invalid`;
      if (!candidateEmails.includes(internal)) candidateEmails.push(internal);
    }
    if (isEmail && !candidateEmails.includes(loginSanitized)) {
      candidateEmails.push(loginSanitized);
    }
    const directInternal = `${loginSanitized}@login.invalid`;
    if (!candidateEmails.includes(directInternal)) {
      candidateEmails.push(directInternal);
    }

    let authData: any = null;
    let authError: any = null;

    // Tenta autenticar no Supabase Auth com os emails candidatos
    for (const emailToTry of candidateEmails) {
      const res = await supabaseAuth.auth.signInWithPassword({
        email: emailToTry,
        password: senha,
      });

      if (!res.error && res.data?.user && res.data?.session) {
        authData = res.data;
        authError = null;
        break;
      } else {
        authError = res.error;
      }
    }

    if (!authData || !authData.user || !authData.session) {
      return jsonResponse(
        { error: "Usuário ou senha inválidos." },
        401,
        origin,
      );
    }

    // Se o perfil ainda não foi encontrado na tabela usuarios (ex: usuário criado no Supabase Auth)
    if (!profile) {
      const { data: pById } = await supabaseAdmin
        .from("usuarios")
        .select("id,nome,usuario,email,role")
        .eq("id", authData.user.id)
        .maybeSingle();

      if (pById) {
        profile = pById;
      } else {
        // Cria perfil para o usuário se não existir
        const defaultUsername =
          authData.user.email?.split("@")[0]?.replace(/[^a-z0-9._-]/gi, "") ||
          "usuario";
        const defaultName =
          authData.user.user_metadata?.nome ||
          authData.user.user_metadata?.name ||
          defaultUsername;

        const { data: newProfile, error: insertErr } = await supabaseAdmin
          .from("usuarios")
          .insert({
            id: authData.user.id,
            nome: defaultName,
            usuario: defaultUsername,
            email: authData.user.email?.endsWith("@login.invalid")
              ? null
              : authData.user.email,
            role: "admin",
          })
          .select("id,nome,usuario,email,role")
          .single();

        if (!insertErr && newProfile) {
          profile = newProfile;
        } else {
          profile = {
            id: authData.user.id,
            nome: defaultName,
            usuario: defaultUsername,
            email: authData.user.email,
            role: "admin",
          };
        }
      }
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
          email: profile.email,
          role: profile.role,
          must_change_password: mustChangePassword,
        },
      },
      200,
      origin,
    );
  } catch (error: unknown) {
    console.error(
      "Erro inesperado em smooth-function:",
      error instanceof Error ? error.message : String(error),
    );

    return jsonResponse(
      { error: "Ocorreu um erro inesperado durante o login." },
      500,
      origin,
    );
  }
});
