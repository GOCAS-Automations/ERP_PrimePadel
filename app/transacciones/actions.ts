"use server";

import { revalidatePath } from "next/cache";
import Papa from "papaparse";
import { transaccionSchema } from "@/lib/validators/producto";
import { exportCsvSchema } from "@/lib/validators/export-csv";
import { sbAdmin } from "@/lib/supabase/admin-server";
import { requireProfile, requireAdmin } from "@/lib/auth";
import { humanizarError } from "@/lib/errors";
import { getCostoPromedioPorProducto, getPreciosTarifa } from "@/lib/queries";

type ActionResult<T = unknown> =
  T extends object ? ({ ok: true } & T) | { error: string } : { ok: true } | { error: string };

// ---------------------------------------------------------------------------
// Crear transacción
// ---------------------------------------------------------------------------
export async function registrarTransaccion(input: unknown): Promise<ActionResult<{ id: string }>> {
  const perfil = await requireProfile();
  const parsed = transaccionSchema.parse(input);
  // Recepción puede registrar ventas y traslados (no compras).
  if (perfil.rol === "recepcion" && parsed.tipo === "compra") {
    return { error: "Tu rol no permite registrar compras. Pídele a un admin que la registre." };
  }
  // Recepción no puede usar "Otro / Personalizado" (precio libre) — toda venta
  // suya debe llevar una tarifa válida. Es la misma regla que esconde la UI;
  // la replicamos en servidor por si alguien arma la request a mano.
  if (perfil.rol === "recepcion" && parsed.tipo === "venta") {
    const sinTarifa = parsed.items.some((it) => !it.lista_precio_id);
    if (sinTarifa) {
      return { error: "Tu rol requiere elegir una tarifa para cada producto vendido. La opción 'Otro / Personalizado' solo está disponible para admin o maestro." };
    }
  }
  // En ventas, sobrescribir costo_unitario con el COSTO PROMEDIO DE COMPRA del
  // producto al momento de la venta (snapshot real). Si el producto aún no
  // tiene compras registradas, queda en 0.
  let items = parsed.items;
  // Recepción: el precio de cada ítem lo fija el servidor según la tarifa
  // elegida (si no, bastaría editar la request para vender a cualquier precio).
  if (perfil.rol === "recepcion" && parsed.tipo === "venta") {
    const precios = await getPreciosTarifa(Array.from(new Set(items.map((it) => it.producto_id))));
    if (items.some((it) => !precios.has(`${it.producto_id}|${it.lista_precio_id}`))) {
      return { error: "Una de las tarifas elegidas no está disponible para ese producto. Recarga la página e intenta de nuevo." };
    }
    items = items.map((it) => ({ ...it, precio_unitario: precios.get(`${it.producto_id}|${it.lista_precio_id}`)! }));
  }
  if (parsed.tipo === "venta") {
    const costoProm = await getCostoPromedioPorProducto();
    items = items.map((it) => ({
      ...it,
      costo_unitario: costoProm.get(it.producto_id) ?? 0,
    }));
  }
  const { data, error } = await sbAdmin().rpc("registrar_transaccion", {
    p_tipo: parsed.tipo,
    p_fecha: parsed.fecha ?? null,
    p_usuario: perfil.user_id,
    p_notas: parsed.notas ?? null,
    p_origen: parsed.origen,
    p_items: items,
  });
  if (error) return { error: humanizarError(error.message) };
  revalidatePath("/transacciones");
  revalidatePath("/inventario");
  revalidatePath("/dashboard");
  return { ok: true, id: data as string };
}

// ---------------------------------------------------------------------------
// Eliminar transacción (admin, o cajero dueño del mismo día)
// ---------------------------------------------------------------------------
export async function deleteTransaccion(id: string): Promise<ActionResult> {
  const perfil = await requireProfile();
  const tx = await fetchTxParaReversa(id);
  if (!tx) return { error: "Transacción no encontrada" };

  const permiso = checarPermisoEdicion(perfil, tx);
  if (!permiso.ok) return { error: permiso.error };

  const reversa = await aplicarReversaStock(tx);
  if (reversa.error) {
    return { error: "No se pudo revertir el stock para eliminar esta transacción: " + humanizarError(reversa.error) };
  }

  const { error } = await sbAdmin().from("transacciones").delete().eq("id", id);
  if (error) return { error: humanizarError(error.message) };

  revalidatePath("/transacciones");
  revalidatePath("/inventario");
  revalidatePath("/dashboard");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Editar transacción
//
// Camino A — "edición ligera" (sin tocar stock): se aplica cuando los items
// estructurales (producto, ubicaciones, cantidad) NO cambian. Solo se editan
// precio_unitario, costo_unitario, lista_precio_id, fecha o notas. Esto es
// crítico porque revertir y recrear una compra antigua puede fallar si ya se
// vendió/movió parte del stock (cantidad negativa al revertir).
//
// Camino B — "reverse + recreate": cuando cambia algo del stock (cantidades,
// ubicaciones, productos, tipo). Mantiene el rollback automático si falla.
// ---------------------------------------------------------------------------
export async function editarTransaccion(id: string, input: unknown): Promise<ActionResult<{ newId: string }>> {
  const perfil = await requireProfile();
  const parsed = transaccionSchema.parse(input);

  // Recepción no puede convertir nada a compra.
  if (perfil.rol === "recepcion" && parsed.tipo === "compra") {
    return { error: "Tu rol no permite registrar compras." };
  }

  const original = await fetchTxParaReversa(id);
  if (!original) return { error: "Transacción no encontrada" };

  const permiso = checarPermisoEdicion(perfil, original);
  if (!permiso.ok) return { error: permiso.error };

  // ¿Cambió la estructura (tipo, items, ubicaciones, cantidades)?
  const cambiaEstructura = detectarCambioEstructura(original, parsed);

  // -------------------- Camino A: edición ligera (sin tocar stock) --------------------
  if (!cambiaEstructura) {
    return await editarSoloMetadata(id, parsed, perfil.user_id, original.tipo === "venta");
  }

  // En ventas el costo lo fija SIEMPRE el servidor (costo promedio de compra),
  // igual que en registrarTransaccion; nunca el valor enviado por el cliente.
  let itemsNuevos = parsed.items;
  if (parsed.tipo === "venta") {
    const costoProm = await getCostoPromedioPorProducto();
    itemsNuevos = parsed.items.map((it) => ({ ...it, costo_unitario: costoProm.get(it.producto_id) ?? 0 }));
  }

  // -------------------- Camino B: reverse + recreate --------------------

  // Snapshot completo de la original para poder rehacerla si la nueva falla.
  const snapshot = await fetchTxCompleta(id);
  if (!snapshot) return { error: "No se pudo capturar la transacción original" };

  // 1. Borrar original (revierte stock + DELETE row).
  const reversa = await aplicarReversaStock(original);
  if (reversa.error) {
    return { error: "No se pudo revertir la transacción original: " + humanizarError(reversa.error) };
  }
  const { error: eDel } = await sbAdmin().from("transacciones").delete().eq("id", id);
  if (eDel) return { error: "No se pudo eliminar la transacción original: " + humanizarError(eDel.message) };

  // 2. Crear nueva — preservando al CREADOR original (usuario_id) para que la
  //    columna "Registró" no cambie. La edición se marca aparte (actualizado_*).
  const creadorOriginal = original.usuario_id ?? perfil.user_id;
  const { data: newId, error: eIns } = await sbAdmin().rpc("registrar_transaccion", {
    p_tipo: parsed.tipo,
    p_fecha: parsed.fecha ?? snapshot.fecha,
    p_usuario: creadorOriginal,
    p_notas: parsed.notas ?? null,
    p_origen: parsed.origen,
    p_items: itemsNuevos,
  });

  if (eIns) {
    // 3. Rollback: rehacer la original con sus mismos datos.
    const { error: eRoll } = await sbAdmin().rpc("registrar_transaccion", {
      p_tipo: snapshot.tipo,
      p_fecha: snapshot.fecha,
      p_usuario: snapshot.usuario_id,
      p_notas: snapshot.notas,
      p_origen: snapshot.origen,
      p_items: snapshot.items,
    });
    if (eRoll) {
      return {
        error: `No se pudo guardar la edición (${humanizarError(eIns.message)}). El intento de restaurar la versión original también falló (${humanizarError(eRoll.message)}). Por favor revisa el inventario manualmente y avísale al administrador.`,
      };
    }
    return { error: "No se pudo guardar la edición: " + humanizarError(eIns.message) + " — Se restauró la versión original sin cambios." };
  }

  // Marcar la edición (quién y cuándo) en la transacción recién recreada.
  await sbAdmin()
    .from("transacciones")
    .update({ actualizado_en: new Date().toISOString(), actualizado_por: perfil.user_id })
    .eq("id", newId as string);

  revalidatePath("/transacciones");
  revalidatePath("/inventario");
  revalidatePath("/dashboard");
  return { ok: true, newId: newId as string };
}

// Comprueba si los items nuevos preservan la estructura (producto + ubicaciones + cantidad).
// Si todo eso es igual, no hace falta tocar stock — solo cambian precio/costo/notas/fecha/lista.
function detectarCambioEstructura(
  original: TxParaReversa,
  parsed: { tipo: string; items: { producto_id: string; ubicacion_origen_id?: string | null; ubicacion_destino_id?: string | null; cantidad: number }[] },
): boolean {
  if (original.tipo !== parsed.tipo) return true;
  if (original.items.length !== parsed.items.length) return true;

  // Empareja items por firma (producto + origen + destino + cantidad).
  const firma = (it: { producto_id: string; ubicacion_origen_id?: string | null; ubicacion_destino_id?: string | null; cantidad: number }) =>
    `${it.producto_id}|${it.ubicacion_origen_id ?? ""}|${it.ubicacion_destino_id ?? ""}|${it.cantidad}`;

  const firmasOriginal = original.items.map((it) =>
    firma({
      producto_id: it.producto_id,
      ubicacion_origen_id: it.ubicacion_origen_id,
      ubicacion_destino_id: it.ubicacion_destino_id,
      cantidad: it.cantidad,
    }),
  ).sort();
  const firmasNuevas = parsed.items.map(firma).sort();

  for (let i = 0; i < firmasOriginal.length; i++) {
    if (firmasOriginal[i] !== firmasNuevas[i]) return true;
  }
  return false;
}

// Edición sin tocar stock: UPDATE directo de header + items.
async function editarSoloMetadata(
  id: string,
  parsed: { fecha?: string; notas?: string | null; items: { producto_id: string; ubicacion_origen_id?: string | null; ubicacion_destino_id?: string | null; cantidad: number; precio_unitario: number; costo_unitario?: number; lista_precio_id?: string | null }[] },
  editorId: string,
  esVenta: boolean,
): Promise<ActionResult<{ newId: string }>> {
  const sb = sbAdmin();

  // 1. Trae items actuales con ID (necesitamos el id para el UPDATE).
  const { data: itemsBD, error: eFetch } = await sb
    .from("transaccion_items")
    .select("id, producto_id, ubicacion_origen_id, ubicacion_destino_id, cantidad, costo_unitario")
    .eq("transaccion_id", id);
  if (eFetch) return { error: humanizarError(eFetch.message) };

  // Empareja cada item del payload con su row en BD por firma.
  const firma = (it: any) =>
    `${it.producto_id}|${it.ubicacion_origen_id ?? ""}|${it.ubicacion_destino_id ?? ""}|${Number(it.cantidad)}`;
  const bdPorFirma = new Map<string, { id: string; costo: number }[]>(); // firma -> items disponibles
  for (const r of itemsBD ?? []) {
    const f = firma(r);
    if (!bdPorFirma.has(f)) bdPorFirma.set(f, []);
    bdPorFirma.get(f)!.push({ id: r.id as string, costo: Number(r.costo_unitario ?? 0) });
  }

  // 2. Para cada item del payload, encuentra el id de BD y actualiza precio/costo.
  let totalNuevo = 0;
  for (const it of parsed.items) {
    const f = firma(it);
    const candidatos = bdPorFirma.get(f);
    if (!candidatos || candidatos.length === 0) {
      // No debería pasar si detectarCambioEstructura es correcto, pero por si acaso.
      return { error: "No se pudo emparejar uno de los productos al actualizar. Intenta de nuevo o avísale al administrador." };
    }
    const { id: itemId, costo: costoBD } = candidatos.shift()!;
    const precio = Number(it.precio_unitario);
    // Venta: se conserva el snapshot de costo guardado (no lo decide el cliente).
    const costo = esVenta ? costoBD : Number(it.costo_unitario ?? it.precio_unitario);
    const cantidad = Number(it.cantidad);
    const subtotal = cantidad * precio;
    totalNuevo += subtotal;

    const { error: eUpd } = await sb
      .from("transaccion_items")
      .update({
        precio_unitario: precio,
        costo_unitario: costo,
        subtotal,
        lista_precio_id: it.lista_precio_id ?? null,
      })
      .eq("id", itemId);
    if (eUpd) return { error: humanizarError(eUpd.message) };
  }

  // 3. Actualiza header (fecha + notas + total) + marca de edición.
  const headerPayload: Record<string, unknown> = {
    notas: parsed.notas ?? null,
    total: totalNuevo,
    actualizado_en: new Date().toISOString(),
    actualizado_por: editorId,
  };
  if (parsed.fecha) headerPayload.fecha = parsed.fecha;
  const { error: eHdr } = await sb.from("transacciones").update(headerPayload).eq("id", id);
  if (eHdr) return { error: humanizarError(eHdr.message) };

  revalidatePath("/transacciones");
  revalidatePath("/inventario");
  revalidatePath("/dashboard");
  return { ok: true, newId: id };
}

// ---------------------------------------------------------------------------
// Exportar transacciones a CSV (admin/maestro). Dos modos:
//   - por_item:        una fila por cada ítem (consumo detallado por producto).
//   - por_transaccion: una fila por transacción (resumen).
// ---------------------------------------------------------------------------
export async function exportarTransaccionesCSV(
  input: unknown,
): Promise<{ ok: true; csv: string; filename: string } | { error: string }> {
  await requireAdmin();
  const parsed = exportCsvSchema.parse(input);

  // Bogotá es UTC-5 sin DST. Convertimos las fechas locales a un rango UTC.
  const inicioISO = `${parsed.fecha_inicio}T00:00:00-05:00`;
  const finISO = `${parsed.fecha_fin}T23:59:59-05:00`;

  const sb = sbAdmin();
  const { data: txs, error } = await sb
    .from("transacciones")
    .select(
      `id, tipo, fecha, total, notas, origen, usuario_id,
       transaccion_items(
         producto_id, cantidad, subtotal, costo_unitario,
         productos(codigo, nombre, categorias(nombre))
       )`,
    )
    .gte("fecha", inicioISO)
    .lte("fecha", finISO)
    .order("fecha", { ascending: false });

  if (error) return { error: humanizarError(error.message) };

  // Fallback: si una venta antigua quedó con costo_unitario = 0, usamos el
  // costo promedio de compra del producto para no subestimar costos/margen.
  const costoFallback = await getCostoPromedioPorProducto();

  const userIds = Array.from(
    new Set((txs ?? []).map((t: any) => t.usuario_id).filter(Boolean) as string[]),
  );
  const { data: perfilesData } = userIds.length
    ? await sb.from("perfiles").select("user_id, nombre").in("user_id", userIds)
    : { data: [] as { user_id: string; nombre: string }[] };
  const nombrePorUser = new Map(
    (perfilesData ?? []).map((p: any) => [p.user_id as string, p.nombre as string]),
  );

  const fmtFecha = (iso: string) =>
    new Date(iso).toLocaleString("es-CO", { timeZone: "America/Bogota", hour12: false });

  let rows: Record<string, unknown>[];
  if (parsed.modo === "por_item") {
    // Agregado por (producto, tipo). Solo ventas y compras (los traslados no
    // representan consumo ni compra real, son movimientos internos).
    type Bucket = {
      tipo: "venta" | "compra";
      codigo: string;
      nombre: string;
      categoria: string;
      cantidad_total: number;
      valor_total: number;
      costo_total: number;
      transacciones: Set<string>;
      primera_fecha: string;
      ultima_fecha: string;
    };
    const buckets = new Map<string, Bucket>();

    for (const t of (txs ?? []) as any[]) {
      if (t.tipo !== "venta" && t.tipo !== "compra") continue;
      for (const it of t.transaccion_items ?? []) {
        const key = `${it.productos?.codigo ?? it.producto_id ?? ""}|${t.tipo}`;
        let b = buckets.get(key);
        if (!b) {
          b = {
            tipo: t.tipo,
            codigo: it.productos?.codigo ?? "",
            nombre: it.productos?.nombre ?? "",
            categoria: it.productos?.categorias?.nombre ?? "",
            cantidad_total: 0,
            valor_total: 0,
            costo_total: 0,
            transacciones: new Set<string>(),
            primera_fecha: t.fecha,
            ultima_fecha: t.fecha,
          };
          buckets.set(key, b);
        }
        b.cantidad_total += Number(it.cantidad);
        b.valor_total += Number(it.subtotal);
        const costoEfectivo =
          Number(it.costo_unitario ?? 0) || (costoFallback.get(it.producto_id) ?? 0);
        b.costo_total += Number(it.cantidad) * costoEfectivo;
        b.transacciones.add(t.id);
        if (t.fecha < b.primera_fecha) b.primera_fecha = t.fecha;
        if (t.fecha > b.ultima_fecha) b.ultima_fecha = t.fecha;
      }
    }

    rows = Array.from(buckets.values())
      .sort((a, b) => a.nombre.localeCompare(b.nombre, "es") || a.tipo.localeCompare(b.tipo))
      .map((b) => {
        const precio_promedio =
          b.cantidad_total > 0
            ? Math.round((b.valor_total / b.cantidad_total) * 100) / 100
            : 0;
        const margen_total = b.tipo === "venta" ? b.valor_total - b.costo_total : 0;
        const margen_pct =
          b.tipo === "venta" && b.valor_total > 0
            ? Math.round((margen_total / b.valor_total) * 10000) / 100
            : 0;
        return {
          tipo: b.tipo,
          codigo_producto: b.codigo,
          producto: b.nombre,
          categoria: b.categoria,
          cantidad_total: b.cantidad_total,
          valor_total: b.valor_total,
          costo_total: Math.round(b.costo_total * 100) / 100,
          margen_total: b.tipo === "venta" ? Math.round(margen_total * 100) / 100 : "",
          margen_pct: b.tipo === "venta" ? margen_pct : "",
          precio_promedio,
          num_transacciones: b.transacciones.size,
          primera_fecha: fmtFecha(b.primera_fecha),
          ultima_fecha: fmtFecha(b.ultima_fecha),
        };
      });
  } else {
    rows = ((txs ?? []) as any[]).map((t) => {
      const items = (t.transaccion_items ?? []) as any[];
      const cantidad_total = items.reduce((s, it) => s + Number(it.cantidad), 0);
      const resumen = items
        .slice(0, 5)
        .map((it) => `${Number(it.cantidad)}× ${it.productos?.nombre ?? ""}`)
        .join(" | ");
      const productos_resumen =
        items.length > 5 ? `${resumen} | (+${items.length - 5} más)` : resumen;
      return {
        fecha: fmtFecha(t.fecha),
        tipo: t.tipo,
        num_items: items.length,
        cantidad_total,
        productos_resumen,
        total: Number(t.total),
        usuario: t.usuario_id ? nombrePorUser.get(t.usuario_id) ?? "" : "",
        notas: t.notas ?? "",
        origen: t.origen,
        transaccion_id: t.id,
      };
    });
  }

  // escapeFormulae: antepone ' a celdas de texto que empiecen por = + - @ (inyección
  // de fórmulas al abrir el CSV en Excel; notas y nombres los escribe el usuario).
  const csv = Papa.unparse(rows, { quotes: true, escapeFormulae: true });
  const filename = `transacciones_${parsed.modo}_${parsed.fecha_inicio}_${parsed.fecha_fin}.csv`;
  return { ok: true, csv, filename };
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

type TxParaReversa = {
  id: string;
  tipo: "compra" | "venta" | "traslado";
  usuario_id: string | null;
  usuario_rol: "maestro" | "admin" | "recepcion" | null;
  fecha: string;
  items: {
    producto_id: string;
    ubicacion_origen_id: string | null;
    ubicacion_destino_id: string | null;
    cantidad: number;
    es_inventariable: boolean;
  }[];
};

async function fetchTxParaReversa(id: string): Promise<TxParaReversa | null> {
  const sb = sbAdmin();
  const { data, error } = await sb
    .from("transacciones")
    .select(
      "id, tipo, usuario_id, fecha, transaccion_items(producto_id, ubicacion_origen_id, ubicacion_destino_id, cantidad, productos(es_inventariable))",
    )
    .eq("id", id)
    .single();
  if (error || !data) return null;

  let usuario_rol: TxParaReversa["usuario_rol"] = null;
  if (data.usuario_id) {
    const { data: perfilCreador } = await sb
      .from("perfiles")
      .select("rol")
      .eq("user_id", data.usuario_id)
      .maybeSingle();
    usuario_rol = (perfilCreador?.rol ?? null) as TxParaReversa["usuario_rol"];
  }

  return {
    id: data.id,
    tipo: data.tipo,
    usuario_id: data.usuario_id,
    usuario_rol,
    fecha: data.fecha,
    items: ((data as any).transaccion_items ?? []).map((it: any) => ({
      producto_id: it.producto_id,
      ubicacion_origen_id: it.ubicacion_origen_id,
      ubicacion_destino_id: it.ubicacion_destino_id,
      cantidad: Number(it.cantidad),
      es_inventariable: !!it.productos?.es_inventariable,
    })),
  };
}

type TxCompleta = {
  tipo: "compra" | "venta" | "traslado";
  fecha: string;
  usuario_id: string | null;
  notas: string | null;
  origen: string;
  items: any[];
};

async function fetchTxCompleta(id: string): Promise<TxCompleta | null> {
  const { data, error } = await sbAdmin()
    .from("transacciones")
    .select(
      "tipo, fecha, usuario_id, notas, origen, transaccion_items(producto_id, ubicacion_origen_id, ubicacion_destino_id, cantidad, precio_unitario, lista_precio_id)",
    )
    .eq("id", id)
    .single();
  if (error || !data) return null;
  return {
    tipo: data.tipo,
    fecha: data.fecha,
    usuario_id: data.usuario_id,
    notas: data.notas,
    origen: data.origen,
    items: ((data as any).transaccion_items ?? []).map((it: any) => ({
      producto_id: it.producto_id,
      ubicacion_origen_id: it.ubicacion_origen_id,
      ubicacion_destino_id: it.ubicacion_destino_id,
      cantidad: Number(it.cantidad),
      precio_unitario: Number(it.precio_unitario),
      lista_precio_id: it.lista_precio_id,
    })),
  };
}

function checarPermisoEdicion(
  perfil: { rol: "maestro" | "admin" | "recepcion"; user_id: string },
  tx: TxParaReversa,
): { ok: true } | { ok: false; error: string } {
  // Maestro tiene control total.
  if (perfil.rol === "maestro") return { ok: true };

  // Admin: puede editar/eliminar cualquier transacción que NO haya sido creada por un maestro.
  if (perfil.rol === "admin") {
    if (tx.usuario_rol === "maestro") {
      return { ok: false, error: "Solo el rol Maestro puede modificar transacciones creadas por otro Maestro." };
    }
    return { ok: true };
  }

  // Recepción: NO puede editar ni eliminar ninguna transacción (ni siquiera las
  // suyas). Cualquier corrección la pide a un admin o maestro.
  void tx;
  return {
    ok: false,
    error: "Tu rol no permite editar ni eliminar transacciones. Comunícate con un administrador o el Maestro para hacer cambios.",
  };
}

function mismaFechaLocal(iso: string, ref: Date) {
  const a = new Date(iso);
  return a.getFullYear() === ref.getFullYear()
    && a.getMonth() === ref.getMonth()
    && a.getDate() === ref.getDate();
}

// Revierte el efecto de una transacción sobre el stock (compra/venta/traslado).
async function aplicarReversaStock(tx: TxParaReversa): Promise<{ ok?: true; error?: string }> {
  const sb = sbAdmin();
  for (const it of tx.items) {
    if (!it.es_inventariable) continue;

    if (tx.tipo === "compra" && it.ubicacion_destino_id) {
      const actual = await cantidadActual(sb, it.producto_id, it.ubicacion_destino_id);
      const { error } = await sb.rpc("registrar_ajuste_inventario", {
        p_producto: it.producto_id,
        p_ubicacion: it.ubicacion_destino_id,
        p_cantidad_nueva: actual - it.cantidad,
        p_motivo: "correccion",
        p_notas: `Reversa de transacción ${tx.id}`,
        p_usuario: null,
      });
      if (error) return { error: error.message };
    } else if (tx.tipo === "venta" && it.ubicacion_origen_id) {
      const actual = await cantidadActual(sb, it.producto_id, it.ubicacion_origen_id);
      const { error } = await sb.rpc("registrar_ajuste_inventario", {
        p_producto: it.producto_id,
        p_ubicacion: it.ubicacion_origen_id,
        p_cantidad_nueva: actual + it.cantidad,
        p_motivo: "correccion",
        p_notas: `Reversa de transacción ${tx.id}`,
        p_usuario: null,
      });
      if (error) return { error: error.message };
    } else if (tx.tipo === "traslado" && it.ubicacion_origen_id && it.ubicacion_destino_id) {
      // En traslado: origen perdió cantidad, destino ganó. Reversa: origen + cant, destino - cant.
      const actualOrig = await cantidadActual(sb, it.producto_id, it.ubicacion_origen_id);
      const r1 = await sb.rpc("registrar_ajuste_inventario", {
        p_producto: it.producto_id,
        p_ubicacion: it.ubicacion_origen_id,
        p_cantidad_nueva: actualOrig + it.cantidad,
        p_motivo: "correccion",
        p_notas: `Reversa de traslado ${tx.id} (origen)`,
        p_usuario: null,
      });
      if (r1.error) return { error: r1.error.message };
      const actualDest = await cantidadActual(sb, it.producto_id, it.ubicacion_destino_id);
      const r2 = await sb.rpc("registrar_ajuste_inventario", {
        p_producto: it.producto_id,
        p_ubicacion: it.ubicacion_destino_id,
        p_cantidad_nueva: actualDest - it.cantidad,
        p_motivo: "correccion",
        p_notas: `Reversa de traslado ${tx.id} (destino)`,
        p_usuario: null,
      });
      if (r2.error) return { error: r2.error.message };
    }
  }
  return { ok: true };
}

async function cantidadActual(sb: any, producto_id: string, ubicacion_id: string): Promise<number> {
  const { data } = await sb
    .from("stock_por_ubicacion")
    .select("cantidad")
    .eq("producto_id", producto_id)
    .eq("ubicacion_id", ubicacion_id)
    .maybeSingle();
  return Number(data?.cantidad ?? 0);
}
