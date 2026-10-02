"use server";

import { revalidatePath } from "next/cache";
import { sbAdmin } from "@/lib/supabase/admin-server";
import { requireMaestro, usernameToEmail, type Rol } from "@/lib/auth";
import { humanizarError } from "@/lib/errors";

export type CreateUsuarioResult =
  | { ok: true; usuario: string; password: string }
  | { error: string };

type ActionResult = { ok: true } | { error: string };

const ROLES_VALIDOS: Rol[] = ["maestro", "admin", "recepcion"];

function generatePassword(): string {
  const charset = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let pw = "";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 10; i++) pw += charset[bytes[i] % charset.length];
  return pw;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Evita dejar el sistema sin ningún maestro activo (bloqueo total de la gestión).
async function quedariaSinMaestro(userId: string): Promise<boolean> {
  const { data } = await sbAdmin()
    .from("perfiles")
    .select("user_id")
    .eq("rol", "maestro")
    .eq("activo", true);
  const otros = (data ?? []).filter((p: { user_id: string }) => p.user_id !== userId);
  return otros.length === 0;
}

function validarUsername(s: string): string | null {
  if (!/^[a-z0-9._-]{3,30}$/.test(s)) {
    return "El usuario debe tener entre 3 y 30 caracteres y solo puede contener letras, números, punto, guion o guion bajo.";
  }
  return null;
}

export async function createUsuario(input: {
  usuario: string;
  nombre: string;
  rol: Rol;
  password?: string;
}): Promise<CreateUsuarioResult> {
  await requireMaestro();

  const usuario = String(input?.usuario ?? "").trim().toLowerCase();
  const nombre = String(input?.nombre ?? "").trim();
  if (!usuario || !nombre) return { error: "Usuario y nombre son obligatorios." };
  if (nombre.length > 100) return { error: "El nombre es demasiado largo (máx. 100 caracteres)." };
  const errUser = validarUsername(usuario);
  if (errUser) return { error: errUser };
  if (!ROLES_VALIDOS.includes(input.rol)) return { error: "Rol inválido." };

  const password = (typeof input.password === "string" ? input.password.trim() : "") || generatePassword();
  if (password.length < 8 || password.length > 72) return { error: "La contraseña debe tener entre 8 y 72 caracteres." };

  const sb = sbAdmin();
  const email = usernameToEmail(usuario);

  const { data: created, error: e1 } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { nombre },
  });

  if (e1 || !created.user) {
    if (/already (been )?registered|already exists/i.test(e1?.message ?? "")) {
      return { error: "Ya existe un usuario con ese nombre de usuario." };
    }
    return { error: "No se pudo crear el usuario. " + humanizarError(e1?.message) };
  }

  const { error: e2 } = await sb.from("perfiles").insert({
    user_id: created.user.id,
    nombre,
    rol: input.rol,
    activo: true,
  });

  if (e2) {
    await sb.auth.admin.deleteUser(created.user.id);
    return { error: humanizarError(e2.message) };
  }

  revalidatePath("/usuarios");
  return { ok: true, usuario, password };
}

export async function toggleActivo(userId: string, activo: boolean): Promise<ActionResult> {
  const yo = await requireMaestro();
  if (!UUID_RE.test(String(userId)) || typeof activo !== "boolean") return { error: "Datos inválidos." };
  if (!activo) {
    if (userId === yo.user_id) return { error: "No puedes desactivar tu propia cuenta." };
    if (await quedariaSinMaestro(userId)) return { error: "Debe quedar al menos un usuario Maestro activo." };
  }
  const { error } = await sbAdmin().from("perfiles").update({ activo }).eq("user_id", userId);
  if (error) return { error: humanizarError(error.message) };
  revalidatePath("/usuarios");
  return { ok: true };
}

export async function cambiarRol(userId: string, rol: Rol): Promise<ActionResult> {
  const yo = await requireMaestro();
  if (!UUID_RE.test(String(userId))) return { error: "Datos inválidos." };
  if (!ROLES_VALIDOS.includes(rol)) return { error: "Rol inválido." };
  if (rol !== "maestro") {
    if (userId === yo.user_id) return { error: "No puedes quitarte a ti mismo el rol Maestro." };
    if (await quedariaSinMaestro(userId)) return { error: "Debe quedar al menos un usuario Maestro activo." };
  }
  const { error } = await sbAdmin().from("perfiles").update({ rol }).eq("user_id", userId);
  if (error) return { error: humanizarError(error.message) };
  revalidatePath("/usuarios");
  return { ok: true };
}

export async function resetPassword(userId: string): Promise<{ ok: true; password: string } | { error: string }> {
  await requireMaestro();
  if (!UUID_RE.test(String(userId))) return { error: "Datos inválidos." };
  const password = generatePassword();
  const { error } = await sbAdmin().auth.admin.updateUserById(userId, { password });
  if (error) return { error: humanizarError(error.message) };
  revalidatePath("/usuarios");
  return { ok: true, password };
}

export async function updateUsuario(
  userId: string,
  input: { nombre?: string; usuario?: string; password?: string | null },
): Promise<ActionResult> {
  await requireMaestro();
  if (!UUID_RE.test(String(userId))) return { error: "Datos inválidos." };
  const sb = sbAdmin();

  const nombre = typeof input?.nombre === "string" ? input.nombre.trim() : undefined;
  const usuario = typeof input?.usuario === "string" ? input.usuario.trim().toLowerCase() : undefined;
  const password = (typeof input?.password === "string" ? input.password.trim() : "") || null;
  if (nombre && nombre.length > 100) return { error: "El nombre es demasiado largo (máx. 100 caracteres)." };

  const authPayload: { email?: string; password?: string; user_metadata?: { nombre: string } } = {};

  if (usuario) {
    const errUser = validarUsername(usuario);
    if (errUser) return { error: errUser };
    authPayload.email = usernameToEmail(usuario);
  }
  if (password) {
    if (password.length < 8 || password.length > 72) return { error: "La contraseña debe tener entre 8 y 72 caracteres." };
    authPayload.password = password;
  }
  if (nombre) authPayload.user_metadata = { nombre };

  if (Object.keys(authPayload).length > 0) {
    const { error } = await sb.auth.admin.updateUserById(userId, authPayload);
    if (error) return { error: humanizarError(error.message) };
  }

  if (nombre) {
    const { error } = await sb.from("perfiles").update({ nombre }).eq("user_id", userId);
    if (error) return { error: humanizarError(error.message) };
  }

  revalidatePath("/usuarios");
  return { ok: true };
}
