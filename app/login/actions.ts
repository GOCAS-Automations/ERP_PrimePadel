"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { sbAdmin } from "@/lib/supabase/admin-server";
import { usernameToEmail } from "@/lib/auth";

// Solo rutas internas: "/algo". Rechaza "//host", "/\host" y esquemas (open redirect).
function safeNext(raw: string): string {
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (/[\r\n\t]/.test(raw)) return "/";
  return raw;
}

// Freno básico de fuerza bruta (memoria por instancia; Supabase Auth no ve la
// IP real del usuario porque el login se hace desde el servidor). Bloquea por
// usuario y por IP tras varios fallos dentro de la ventana.
const VENTANA_MS = 15 * 60 * 1000;
const MAX_FALLOS_USUARIO = 5;
const MAX_FALLOS_IP = 20;
const fallos = new Map<string, { n: number; desde: number }>();

function bloqueado(key: string, max: number): boolean {
  const f = fallos.get(key);
  if (!f) return false;
  if (Date.now() - f.desde > VENTANA_MS) {
    fallos.delete(key);
    return false;
  }
  return f.n >= max;
}

function registrarFallo(key: string) {
  const ahora = Date.now();
  const f = fallos.get(key);
  if (!f || ahora - f.desde > VENTANA_MS) fallos.set(key, { n: 1, desde: ahora });
  else f.n++;
  if (fallos.size > 5000) {
    for (const [k, v] of fallos) if (ahora - v.desde > VENTANA_MS) fallos.delete(k);
  }
}

export async function signIn(_prev: unknown, formData: FormData): Promise<{ error: string | null }> {
  const usuario = String(formData.get("usuario") ?? "").trim().slice(0, 100);
  const password = String(formData.get("password") ?? "").slice(0, 200);
  const next = safeNext(String(formData.get("next") ?? "/"));

  if (!usuario || !password) {
    return { error: "Ingresa tu usuario y contraseña." };
  }

  const email = usernameToEmail(usuario);
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || "desconocida";
  const keyUsuario = `u:${email}`;
  const keyIp = `ip:${ip}`;

  if (bloqueado(keyUsuario, MAX_FALLOS_USUARIO) || bloqueado(keyIp, MAX_FALLOS_IP)) {
    return { error: "Demasiados intentos fallidos. Espera 15 minutos e intenta de nuevo." };
  }

  const sb = await createSupabaseServerClient();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    registrarFallo(keyUsuario);
    registrarFallo(keyIp);
    return { error: "Usuario o contraseña incorrectos." };
  }
  fallos.delete(keyUsuario);

  const { data: perfil } = await sbAdmin()
    .from("perfiles")
    .select("activo")
    .eq("user_id", data.user.id)
    .maybeSingle();

  if (!perfil) {
    await sb.auth.signOut();
    return { error: "Tu cuenta no tiene perfil asignado. Contacta al administrador." };
  }
  if (!perfil.activo) {
    await sb.auth.signOut();
    return { error: "Tu cuenta está desactivada. Contacta al administrador." };
  }

  redirect(next);
}

export async function signOut() {
  const sb = await createSupabaseServerClient();
  await sb.auth.signOut();
  redirect("/login");
}
