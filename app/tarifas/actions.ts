"use server";

import { revalidatePath } from "next/cache";
import { sbAdmin } from "@/lib/supabase/admin-server";
import { requireMaestro } from "@/lib/auth";
import { humanizarError } from "@/lib/errors";

type ActionResult = { ok: true } | { error: string };

function validarCodigo(s: string): string | null {
  if (!/^[A-Z0-9_]{2,30}$/.test(s)) {
    return "El código debe tener 2-30 caracteres en mayúsculas, números o guion bajo (ej. STAFF_PRIME).";
  }
  return null;
}

function validarBasicos(input: { nombre?: unknown; orden?: unknown; activa?: unknown }): string | null {
  if (input.nombre !== undefined && (typeof input.nombre !== "string" || input.nombre.trim().length > 100)) {
    return "El nombre debe tener máximo 100 caracteres.";
  }
  if (input.orden !== undefined && !Number.isInteger(input.orden)) return "El orden debe ser un número entero.";
  if (input.activa !== undefined && typeof input.activa !== "boolean") return "Valor de 'activa' inválido.";
  return null;
}

function validarDescuento(n: number | undefined): string | null {
  if (n === undefined) return null;
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return "El descuento debe ser un número entre 0 y 100.";
  }
  return null;
}

export async function createTarifa(input: {
  codigo: string;
  nombre: string;
  orden: number;
  activa: boolean;
  descuento_porcentaje: number;
}): Promise<ActionResult> {
  await requireMaestro();
  const errBasicos = validarBasicos(input);
  if (errBasicos) return { error: errBasicos };
  const codigo = String(input.codigo ?? "").trim().toUpperCase();
  const nombre = String(input.nombre ?? "").trim();
  if (!nombre) return { error: "El nombre es obligatorio." };
  const errCodigo = validarCodigo(codigo);
  if (errCodigo) return { error: errCodigo };
  const errDesc = validarDescuento(input.descuento_porcentaje);
  if (errDesc) return { error: errDesc };

  const { error } = await sbAdmin().from("listas_precios").insert({
    codigo,
    nombre,
    orden: input.orden,
    activa: input.activa,
    es_default: false,
    descuento_porcentaje: input.descuento_porcentaje,
  });
  if (error) return { error: humanizarError(error.message) };
  revalidatePath("/tarifas");
  revalidatePath("/inventario");
  return { ok: true };
}

export async function updateTarifa(id: string, input: {
  codigo?: string;
  nombre?: string;
  orden?: number;
  activa?: boolean;
  descuento_porcentaje?: number;
}): Promise<ActionResult> {
  await requireMaestro();
  const errBasicos = validarBasicos(input);
  if (errBasicos) return { error: errBasicos };
  const payload: Record<string, unknown> = {};
  if (input.nombre !== undefined) payload.nombre = input.nombre.trim();
  if (input.codigo !== undefined) {
    const codigo = input.codigo.trim().toUpperCase();
    const errCodigo = validarCodigo(codigo);
    if (errCodigo) return { error: errCodigo };
    payload.codigo = codigo;
  }
  if (input.orden !== undefined) payload.orden = input.orden;
  if (input.activa !== undefined) payload.activa = input.activa;
  if (input.descuento_porcentaje !== undefined) {
    const errDesc = validarDescuento(input.descuento_porcentaje);
    if (errDesc) return { error: errDesc };
    payload.descuento_porcentaje = input.descuento_porcentaje;
  }

  const { error } = await sbAdmin().from("listas_precios").update(payload).eq("id", id);
  if (error) return { error: humanizarError(error.message) };
  revalidatePath("/tarifas");
  revalidatePath("/inventario");
  return { ok: true };
}

export async function deleteTarifa(id: string): Promise<ActionResult> {
  await requireMaestro();
  const sb = sbAdmin();
  // No permitir borrar la tarifa default.
  const { data: lista } = await sb.from("listas_precios").select("es_default").eq("id", id).maybeSingle();
  if (lista?.es_default) return { error: "No se puede eliminar la tarifa marcada como default (Detal)." };

  // Si tiene precios asociados, marcamos como inactiva en lugar de borrar.
  const { count } = await sb.from("precios_producto").select("*", { head: true, count: "exact" }).eq("lista_precio_id", id);
  if ((count ?? 0) > 0) {
    const { error } = await sb.from("listas_precios").update({ activa: false }).eq("id", id);
    if (error) return { error: humanizarError(error.message) };
    revalidatePath("/tarifas");
    revalidatePath("/inventario");
    return { ok: true };
  }
  const { error } = await sb.from("listas_precios").delete().eq("id", id);
  if (error) return { error: humanizarError(error.message) };
  revalidatePath("/tarifas");
  revalidatePath("/inventario");
  return { ok: true };
}
