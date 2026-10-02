import { sbAdmin } from "@/lib/supabase/admin-server";
import { getUbicaciones, getListasPrecios } from "@/lib/queries";
import { requireProfile, emailToDisplayUsername } from "@/lib/auth";
import { TransaccionesClient } from "./transacciones-client";

export const dynamic = "force-dynamic";

export default async function TransaccionesPage() {
  const perfil = await requireProfile();
  const sb = sbAdmin();

  // Recepción ve ventas y traslados (no compras); admin/maestro ven todo.
  const txsQuery = sb.from("transacciones").select(`
    id, tipo, fecha, total, notas, origen, usuario_id, actualizado_en, actualizado_por,
    transaccion_items(producto_id, ubicacion_origen_id, ubicacion_destino_id, cantidad, precio_unitario, costo_unitario, lista_precio_id, productos(codigo, nombre, categoria_id, categorias(nombre)))
  `).order("fecha", { ascending: false }).limit(200);
  const txsQueryFinal = perfil.rol === "recepcion" ? txsQuery.in("tipo", ["venta", "traslado"]) : txsQuery;

  const [
    { data: txs },
    { data: productos },
    { data: stock },
    { data: precios },
    { data: perfilesUsuarios },
    { data: authList },
    ubicaciones,
    listasPrecios,
  ] = await Promise.all([
    txsQueryFinal,
    sb.from("productos").select("id, codigo, nombre, tipo, es_inventariable, activo, costo_unitario").eq("activo", true).order("nombre", { ascending: true }),
    sb.from("stock_por_ubicacion").select("producto_id, ubicacion_id, cantidad"),
    sb.from("precios_producto").select("producto_id, lista_precio_id, precio, listas_precios(es_default)"),
    sb.from("perfiles").select("user_id, nombre, rol"),
    sb.auth.admin.listUsers({ perPage: 500 }),
    getUbicaciones(),
    getListasPrecios(),
  ]);

  const stockPorProd = new Map<string, Record<string, number>>();
  for (const s of stock ?? []) {
    if (!stockPorProd.has(s.producto_id)) stockPorProd.set(s.producto_id, {});
    stockPorProd.get(s.producto_id)![s.ubicacion_id] = s.cantidad;
  }

  // Precio Detal por producto + overrides manuales por (producto, tarifa).
  const precioPorProd = new Map<string, number>();
  const overridePorProdTarifa = new Map<string, number>(); // `${prod}|${tarifa}` -> precio
  for (const p of precios ?? []) {
    overridePorProdTarifa.set(`${p.producto_id}|${p.lista_precio_id}`, Number(p.precio));
    if ((p.listas_precios as any)?.es_default) {
      precioPorProd.set(p.producto_id, Number(p.precio));
    }
  }

  // Tarifas activas ordenadas (default primero).
  const tarifasActivas = (listasPrecios as any[])
    .filter((l) => l.activa)
    .sort((a, b) => (b.es_default ? 1 : 0) - (a.es_default ? 1 : 0) || a.orden - b.orden);

  // Resuelve los precios efectivos para cada tarifa de un producto.
  // Permite precio 0 (tarifas con 100% de descuento como "Regalo" / cortesías).
  // Solo descarta la tarifa si no hay forma de resolver un precio
  // (sin override y sin precio Detal base).
  function preciosTarifaDeProducto(prodId: string): { lista_precio_id: string; nombre: string; precio: number }[] {
    const detal = precioPorProd.get(prodId) ?? null;
    const out: { lista_precio_id: string; nombre: string; precio: number }[] = [];
    for (const t of tarifasActivas) {
      const override = overridePorProdTarifa.get(`${prodId}|${t.id}`);
      let precio: number | null = null;
      if (override != null) precio = override;
      else if (t.es_default) precio = detal != null && detal >= 0 ? detal : null;
      else if (detal != null && detal >= 0) precio = Math.round(detal * (1 - Number(t.descuento_porcentaje ?? 0) / 100));
      if (precio != null && precio >= 0) {
        out.push({ lista_precio_id: t.id, nombre: t.nombre, precio });
      }
    }
    return out;
  }

  // Recepción no debe recibir costos: todo lo que se pasa como prop a un client
  // component queda visible en el HTML/payload RSC del navegador.
  const ocultarCostos = perfil.rol === "recepcion";

  const productosOpt = (productos ?? []).map((p: any) => ({
    id: p.id,
    codigo: p.codigo,
    nombre: p.nombre,
    es_inventariable: p.es_inventariable,
    tipo: p.tipo,
    precio_detal: precioPorProd.get(p.id) ?? null,
    costo_unitario: ocultarCostos ? 0 : Number(p.costo_unitario ?? 0),
    stock_por_ubicacion: stockPorProd.get(p.id) ?? {},
    precios_tarifa: preciosTarifaDeProducto(p.id),
  }));

  const ubiNombrePorId = new Map(ubicaciones.map((u) => [u.id, u.nombre]));

  // Mapa user_id → { nombre, username, rol }
  const perfilesPorId = new Map((perfilesUsuarios ?? []).map((p: any) => [p.user_id, p.nombre as string]));
  const rolesPorId = new Map((perfilesUsuarios ?? []).map((p: any) => [p.user_id, p.rol as "maestro" | "admin" | "recepcion"]));
  const usernamesPorId = new Map(
    (authList?.users ?? []).map((u) => [u.id, emailToDisplayUsername(u.email ?? null)]),
  );

  const transacciones = (txs ?? []).map((t: any) => ({
    id: t.id,
    tipo: t.tipo,
    fecha: t.fecha,
    total: Number(t.total),
    notas: t.notas,
    origen: t.origen,
    usuario_id: t.usuario_id,
    usuario_nombre: t.usuario_id ? (perfilesPorId.get(t.usuario_id) ?? null) : null,
    usuario_username: t.usuario_id ? (usernamesPorId.get(t.usuario_id) ?? null) : null,
    usuario_rol: t.usuario_id ? (rolesPorId.get(t.usuario_id) ?? null) : null,
    actualizado_en: t.actualizado_en ?? null,
    actualizado_username: t.actualizado_por ? (usernamesPorId.get(t.actualizado_por) ?? null) : null,
    items: (t.transaccion_items ?? []).map((it: any) => ({
      producto_id: it.producto_id,
      ubicacion_origen_id: it.ubicacion_origen_id,
      ubicacion_destino_id: it.ubicacion_destino_id,
      cantidad: Number(it.cantidad),
      precio_unitario: Number(it.precio_unitario),
      costo_unitario: ocultarCostos ? 0 : Number(it.costo_unitario ?? 0),
      lista_precio_id: it.lista_precio_id,
      productos: it.productos,
      categoria_id: it.productos?.categoria_id ?? null,
      categoria_nombre: it.productos?.categorias?.nombre ?? null,
      ubicacion_origen_nombre: it.ubicacion_origen_id ? ubiNombrePorId.get(it.ubicacion_origen_id) ?? null : null,
      ubicacion_destino_nombre: it.ubicacion_destino_id ? ubiNombrePorId.get(it.ubicacion_destino_id) ?? null : null,
    })),
  }));

  // Categorías y productos disponibles para los filtros (solo activos para no saturar)
  const { data: categoriasData } = await sb.from("categorias").select("id, nombre").eq("activa", true).order("nombre");
  const { data: productosData } = await sb.from("productos").select("id, nombre, codigo").eq("activo", true).order("nombre");

  return (
    <TransaccionesClient
      transacciones={transacciones}
      productos={productosOpt}
      ubicaciones={ubicaciones.filter((u) => u.activa).map((u) => ({ id: u.id, nombre: u.nombre }))}
      listasPrecios={listasPrecios}
      perfilActual={{ rol: perfil.rol, user_id: perfil.user_id }}
      categoriasFiltro={(categoriasData ?? []).map((c: any) => ({ id: c.id, nombre: c.nombre }))}
      productosFiltro={(productosData ?? []).map((p: any) => ({ id: p.id, nombre: p.nombre, codigo: p.codigo }))}
    />
  );
}
