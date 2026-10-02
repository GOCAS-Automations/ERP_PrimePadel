"use server";

import { revalidatePath } from "next/cache";
import { categoriaSchema } from "@/lib/validators/producto";
import { sbAdmin } from "@/lib/supabase/admin-server";
import { requireMaestro } from "@/lib/auth";
import { humanizarError } from "@/lib/errors";

export async function createCategoria(input: unknown) {
  await requireMaestro();
  const parsed = categoriaSchema.parse(input);
  const { error } = await sbAdmin().from("categorias").insert(parsed);
  if (error) return { error: humanizarError(error.message) };
  revalidatePath("/categorias");
  revalidatePath("/inventario");
  return { ok: true };
}

export async function updateCategoria(id: string, input: unknown) {
  await requireMaestro();
  const parsed = categoriaSchema.parse(input);
  const { error } = await sbAdmin().from("categorias").update(parsed).eq("id", id);
  if (error) return { error: humanizarError(error.message) };
  revalidatePath("/categorias");
  revalidatePath("/inventario");
  return { ok: true };
}

export async function deleteCategoria(id: string) {
  await requireMaestro();
  const sb = sbAdmin();
  const { count } = await sb.from("productos").select("*", { head: true, count: "exact" }).eq("categoria_id", id);
  if ((count ?? 0) > 0) {
    const { error } = await sb.from("categorias").update({ activa: false }).eq("id", id);
    if (error) return { error: humanizarError(error.message) };
    revalidatePath("/categorias");
    return { ok: true, softDeleted: true };
  }
  const { error } = await sb.from("categorias").delete().eq("id", id);
  if (error) return { error: humanizarError(error.message) };
  revalidatePath("/categorias");
  return { ok: true };
}
