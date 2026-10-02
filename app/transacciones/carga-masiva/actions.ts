"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { sbAdmin } from "@/lib/supabase/admin-server";
import { requireProfile } from "@/lib/auth";
import { humanizarError } from "@/lib/errors";
import { getCostoPromedioPorProducto, getPreciosTarifa } from "@/lib/queries";
import { buildPlantillaCSV, type Catalogo, type TransaccionAgrupada } from "@/lib/csv/transacciones";

// El CSV se parsea en el navegador; el servidor vuelve a validar lo que llega
// (la request se puede armar a mano).
const gruposSchema = z
  .array(
    z.object({
      tipo: z.enum(["compra", "venta", "traslado"]),
      fecha: z.string().datetime(),
      notas: z.string().max(2000).nullable(),
      ticket: z.string().max(200).nullable(),
      items: z
        .array(
          z.object({
            producto_id: z.string().uuid(),
            ubicacion_id: z.string().uuid(),
            ubicacion_destino_id: z.string().uuid().optional(),
            cantidad: z.number().int().positive().max(1_000_000),
            precio_unitario: z.number().nonnegative().max(1_000_000_000),
            lista_precio_id: z.string().uuid().nullable(),
          }),
        )
        .min(1)
        .max(300),
    }),
  )
  .max(5000);

export type ImportResult = {
  ok: boolean;
  creadas: number;
  fallidas: { ticket: string | null; razon: string }[];
};

export async function importarTransacciones(input: TransaccionAgrupada[]): Promise<ImportResult> {
  const perfil = await requireProfile();
  const val = gruposSchema.safeParse(input);
  if (!val.success) {
    return { ok: false, creadas: 0, fallidas: [{ ticket: null, razon: "El archivo contiene datos inválidos o demasiadas filas. Revisa el CSV e intenta de nuevo." }] };
  }
  const grupos = val.data;
  const sb = sbAdmin();

  // Costo promedio de compra por producto — para el snapshot de costo en ventas.
  // Es lo más fiel al costo real al momento de la venta (no el costo de catálogo).
  const costoPorProd = await getCostoPromedioPorProducto();
  // Recepción: precio fijado por el servidor según la tarifa (igual que en registrarTransaccion).
  const preciosTarifa = perfil.rol === "recepcion"
    ? await getPreciosTarifa(Array.from(new Set(grupos.flatMap((g) => g.items.map((it) => it.producto_id)))))
    : null;

  let creadas = 0;
  const fallidas: { ticket: string | null; razon: string }[] = [];

  for (const g of grupos) {
    // Recepción no puede importar compras.
    if (perfil.rol === "recepcion" && g.tipo === "compra") {
      fallidas.push({ ticket: g.ticket, razon: "Tu rol no permite registrar compras." });
      continue;
    }
    // Recepción no puede importar ventas con tarifa "Otro" (lista_precio_id null).
    // Misma regla que en registrarTransaccion, replicada acá para CSV.
    if (perfil.rol === "recepcion" && g.tipo === "venta" && g.items.some((it) => !it.lista_precio_id)) {
      fallidas.push({ ticket: g.ticket, razon: "Tu rol requiere tarifa válida en cada venta (la opción 'Otro' es solo para admin o maestro)." });
      continue;
    }
    if (preciosTarifa && g.tipo === "venta") {
      if (g.items.some((it) => !preciosTarifa.has(`${it.producto_id}|${it.lista_precio_id}`))) {
        fallidas.push({ ticket: g.ticket, razon: "Una de las tarifas no está disponible para ese producto." });
        continue;
      }
      g.items = g.items.map((it) => ({ ...it, precio_unitario: preciosTarifa.get(`${it.producto_id}|${it.lista_precio_id}`)! }));
    }
    const items = g.items.map((it) => ({
      producto_id: it.producto_id,
      // venta: origen. compra: destino. traslado: ambos.
      ubicacion_origen_id: g.tipo === "compra" ? null : it.ubicacion_id,
      ubicacion_destino_id: g.tipo === "venta" ? null : (g.tipo === "traslado" ? it.ubicacion_destino_id : it.ubicacion_id),
      cantidad: it.cantidad,
      precio_unitario: it.precio_unitario,
      // En compra/traslado el costo coincide con el precio del CSV.
      // En venta usamos el costo actual del producto (snapshot).
      costo_unitario: g.tipo === "compra" || g.tipo === "traslado"
        ? it.precio_unitario
        : (costoPorProd.get(it.producto_id) ?? 0),
      // Tarifa solo se guarda en ventas; null = "Otro" o tipo ≠ venta.
      lista_precio_id: g.tipo === "venta" ? it.lista_precio_id : null,
    }));

    const { error } = await sb.rpc("registrar_transaccion", {
      p_tipo: g.tipo,
      p_fecha: g.fecha,
      p_usuario: perfil.user_id,
      p_notas: g.notas,
      p_origen: "csv",
      p_items: items,
    });

    if (error) {
      fallidas.push({ ticket: g.ticket, razon: humanizarError(error.message) });
    } else {
      creadas++;
    }
  }

  revalidatePath("/transacciones");
  revalidatePath("/inventario");
  revalidatePath("/dashboard");

  return { ok: fallidas.length === 0, creadas, fallidas };
}

// ---------------------------------------------------------------------------
// Descargar plantilla CSV dinámica con una fila por (producto × tipo).
// Recepción solo recibe venta y traslado; admin/maestro reciben los 3 tipos.
// La columna `tarifa` viene pre-llenada con la tarifa default (Detal) en las
// filas de venta. El usuario puede cambiarla por otra tarifa activa o, si es
// admin/maestro, escribir "Otro" y llenar valor_unitario manualmente.
// ---------------------------------------------------------------------------
export async function descargarPlantillaCSV(): Promise<{ ok: true; csv: string; filename: string } | { error: string }> {
  const perfil = await requireProfile();
  const sb = sbAdmin();

  const [{ data: productos }, { data: ubicaciones }, { data: precios }, { data: stock }, { data: tarifas }] = await Promise.all([
    sb.from("productos").select("id, codigo, nombre, activo, es_inventariable, costo_unitario").eq("activo", true).order("nombre"),
    sb.from("ubicaciones").select("id, nombre, tipo, activa").eq("activa", true).order("orden"),
    // Todos los precios manuales por (producto, tarifa) — los usamos para
    // pre-resolver precios_por_tarifa antes de pasarlos al builder.
    sb.from("precios_producto").select("producto_id, lista_precio_id, precio, listas_precios(es_default)"),
    sb.from("stock_por_ubicacion").select("producto_id, ubicacion_id, cantidad"),
    sb.from("listas_precios").select("id, codigo, nombre, es_default, descuento_porcentaje, activa, orden").eq("activa", true).order("orden"),
  ]);

  // Precio default (Detal) y overrides manuales por (producto, tarifa).
  const precioDetalPorProd = new Map<string, number>();
  const overridePorProdTarifa = new Map<string, number>(); // `${prod}|${tarifa}`
  for (const p of (precios ?? []) as any[]) {
    overridePorProdTarifa.set(`${p.producto_id}|${p.lista_precio_id}`, Number(p.precio));
    if (p.listas_precios?.es_default === true) {
      precioDetalPorProd.set(p.producto_id, Number(p.precio ?? 0));
    }
  }

  const stockPorProd = new Map<string, Record<string, number>>();
  for (const s of (stock ?? []) as any[]) {
    if (!stockPorProd.has(s.producto_id)) stockPorProd.set(s.producto_id, {});
    stockPorProd.get(s.producto_id)![s.ubicacion_id] = Number(s.cantidad);
  }

  const tarifasActivas = ((tarifas ?? []) as any[]).map((t) => ({
    id: t.id as string,
    codigo: t.codigo as string,
    nombre: t.nombre as string,
    es_default: !!t.es_default,
    descuento_porcentaje: Number(t.descuento_porcentaje ?? 0),
    activa: !!t.activa,
  }));

  // Resuelve el precio efectivo para cada tarifa de un producto. Si hay un
  // precio manual (override) usa ese; si no, aplica el descuento al Detal.
  function precioPorTarifa(productoId: string): Record<string, number> {
    // Permite precio 0 — útil para tarifas de regalo/cortesía con 100% desc.
    const detal = precioDetalPorProd.get(productoId);
    const out: Record<string, number> = {};
    for (const t of tarifasActivas) {
      const override = overridePorProdTarifa.get(`${productoId}|${t.id}`);
      let p: number | null = null;
      if (override != null && override >= 0) p = override;
      else if (t.es_default) p = detal != null && detal >= 0 ? detal : null;
      else if (detal != null && detal >= 0) p = Math.round(detal * (1 - t.descuento_porcentaje / 100));
      if (p != null && p >= 0) out[t.id] = p;
    }
    return out;
  }

  const esRecepcion = perfil.rol === "recepcion";
  const catalogo: Catalogo = {
    productos: (productos ?? []).map((p: any) => ({
      id: p.id,
      codigo: p.codigo,
      nombre: p.nombre,
      activo: p.activo,
      es_inventariable: p.es_inventariable,
      precio_detal: precioDetalPorProd.get(p.id) ?? 0,
      // Recepción no ve costos (la plantilla los usa como valor de traslado).
      costo_unitario: esRecepcion ? 0 : Number(p.costo_unitario ?? 0),
      stock_por_ubicacion: stockPorProd.get(p.id) ?? {},
      precios_por_tarifa: precioPorTarifa(p.id),
    })),
    ubicaciones: (ubicaciones ?? []).map((u: any) => ({ id: u.id, nombre: u.nombre, tipo: u.tipo, activa: u.activa })),
    tarifas: tarifasActivas,
  };

  const csv = buildPlantillaCSV(catalogo, {
    incluyeCompras: !esRecepcion,
    incluyeTraslados: true,
  });

  const fecha = new Date().toISOString().slice(0, 10);
  const filename = `plantilla-transacciones-${fecha}.csv`;
  return { ok: true, csv, filename };
}
