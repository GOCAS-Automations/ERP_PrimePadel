"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { productoSchema, ajusteInventarioSchema } from "@/lib/validators/producto";

const preciosSchema = z
  .array(z.object({ lista_precio_id: z.string().uuid(), precio: z.number().nonnegative().max(1_000_000_000) }))
  .max(100);
import { sbAdmin } from "@/lib/supabase/admin-server";
import { requireAdmin, requireMaestro } from "@/lib/auth";
import { humanizarError } from "@/lib/errors";

// Campos que solo puede tocar maestro (afectan finanzas).
const CAMPOS_MAESTRO = ["costo_unitario"] as const;

function stripMaestroFields<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const clone: Record<string, unknown> = { ...obj };
  for (const k of CAMPOS_MAESTRO) delete clone[k];
  return clone as Partial<T>;
}

export async function createProducto(input: unknown, preciosInput: { lista_precio_id: string; precio: number }[] = []) {
  const perfil = await requireAdmin();
  const parsed = productoSchema.parse(input);
  const precios = preciosSchema.parse(preciosInput);
  const payload = perfil.rol === "maestro" ? parsed : stripMaestroFields(parsed);
  const sb = sbAdmin();
  const { data, error } = await sb.from("productos").insert(payload).select("id").single();
  if (error) return { error: humanizarError(error.message) };
  // Solo maestro puede fijar precios.
  if (perfil.rol === "maestro" && precios.length > 0) {
    const payloadPrecios = precios.filter((p) => p.precio > 0).map((p) => ({ ...p, producto_id: data.id }));
    if (payloadPrecios.length > 0) {
      const { error: e2 } = await sb.from("precios_producto").insert(payloadPrecios);
      if (e2) return { error: humanizarError(e2.message) };
    }
  }
  revalidatePath("/inventario");
  revalidatePath("/dashboard");
  return { ok: true, id: data.id };
}

export async function updateProducto(id: string, input: unknown, preciosInput: { lista_precio_id: string; precio: number }[] = []) {
  const perfil = await requireAdmin();
  const parsed = productoSchema.parse(input);
  const precios = preciosSchema.parse(preciosInput);
  const payload = perfil.rol === "maestro" ? parsed : stripMaestroFields(parsed);
  const sb = sbAdmin();
  const { error } = await sb.from("productos").update(payload).eq("id", id);
  if (error) return { error: humanizarError(error.message) };
  if (perfil.rol === "maestro" && precios.length > 0) {
    const ids = precios.map((p) => p.lista_precio_id);
    await sb.from("precios_producto").delete().eq("producto_id", id).in("lista_precio_id", ids);
    const payloadPrecios = precios.filter((p) => p.precio > 0).map((p) => ({ ...p, producto_id: id }));
    if (payloadPrecios.length > 0) {
      const { error: e2 } = await sb.from("precios_producto").insert(payloadPrecios);
      if (e2) return { error: humanizarError(e2.message) };
    }
  }
  revalidatePath("/inventario");
  revalidatePath(`/inventario/${id}`);
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function deleteProducto(id: string) {
  await requireMaestro();
  const sb = sbAdmin();
  const [{ count: histCount }, { count: txItems }] = await Promise.all([
    sb.from("ventas_historicas_mensuales").select("*", { head: true, count: "exact" }).eq("producto_id", id),
    sb.from("transaccion_items").select("*", { head: true, count: "exact" }).eq("producto_id", id),
  ]);
  if ((histCount ?? 0) + (txItems ?? 0) > 0) {
    const { error } = await sb.from("productos").update({ activo: false }).eq("id", id);
    if (error) return { error: humanizarError(error.message) };
    revalidatePath("/inventario");
    return { ok: true, softDeleted: true };
  }
  const { error } = await sb.from("productos").delete().eq("id", id);
  if (error) return { error: humanizarError(error.message) };
  revalidatePath("/inventario");
  return { ok: true };
}

export async function registrarAjusteInventario(input: unknown) {
  const perfil = await requireAdmin();
  const parsed = ajusteInventarioSchema.parse(input);
  const sb = sbAdmin();
  const { data, error } = await sb.rpc("registrar_ajuste_inventario", {
    p_producto: parsed.producto_id,
    p_ubicacion: parsed.ubicacion_id,
    p_cantidad_nueva: parsed.cantidad_nueva,
    p_motivo: parsed.motivo,
    p_notas: parsed.notas ?? null,
    p_usuario: perfil.user_id,
  });
  if (error) return { error: humanizarError(error.message) };
  revalidatePath("/inventario");
  revalidatePath(`/inventario/${parsed.producto_id}`);
  revalidatePath("/dashboard");
  return { ok: true, id: data as string };
}
