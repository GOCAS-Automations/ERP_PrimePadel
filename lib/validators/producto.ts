import { z } from "zod";

export const productoSchema = z.object({
  codigo: z.string().trim().max(40).optional().nullable(),
  nombre: z.string().trim().min(1, "Nombre requerido").max(200),
  tipo: z.enum(["producto", "servicio"]),
  categoria_id: z.string().uuid().nullable(),
  es_inventariable: z.boolean(),
  stock_minimo_alerta: z.number().int().nonnegative().default(0),
  costo_unitario: z.number().nonnegative().default(0),
  impuesto_id: z.string().uuid().nullable(),
  incluye_impuesto_en_precio: z.boolean().default(true),
  unidad_medida: z.string().max(40).optional().nullable(),
  descripcion_larga: z.string().max(2000).optional().nullable(),
  referencia_fabrica: z.string().max(100).optional().nullable(),
  codigo_barras: z.string().max(50).optional().nullable(),
  marca: z.string().max(100).optional().nullable(),
  modelo: z.string().max(100).optional().nullable(),
  visible_en_factura: z.boolean().default(true),
  activo: z.boolean().default(true),
});
export type ProductoInput = z.infer<typeof productoSchema>;

export const categoriaSchema = z.object({
  nombre: z.string().trim().min(1).max(100),
  descripcion: z.string().max(500).optional().nullable(),
  orden: z.number().int().default(0),
  activa: z.boolean().default(true),
});
export type CategoriaInput = z.infer<typeof categoriaSchema>;

export const ubicacionSchema = z.object({
  nombre: z.string().trim().min(1).max(100),
  tipo: z.enum(["bodega", "nevera", "barra", "vitrina", "oficina", "otro"]),
  descripcion: z.string().max(500).optional().nullable(),
  orden: z.number().int().default(0),
  activa: z.boolean().default(true),
});
export type UbicacionInput = z.infer<typeof ubicacionSchema>;

export const precioProductoSchema = z.object({
  producto_id: z.string().uuid(),
  lista_precio_id: z.string().uuid(),
  precio: z.number().nonnegative(),
});

export const transaccionItemSchema = z
  .object({
    producto_id: z.string().uuid(),
    ubicacion_origen_id: z.string().uuid().nullable().optional(),
    ubicacion_destino_id: z.string().uuid().nullable().optional(),
    cantidad: z.number().int().positive().max(1_000_000),
    precio_unitario: z.number().nonnegative().max(1_000_000_000),
    // Costo al momento de la transacción. Si no se pasa, el RPC asume = precio_unitario.
    costo_unitario: z.number().nonnegative().max(1_000_000_000).optional(),
    lista_precio_id: z.string().uuid().nullable().optional(),
  });

export const transaccionSchema = z
  .object({
    tipo: z.enum(["compra", "venta", "traslado"]),
    fecha: z.string().datetime().optional(),
    notas: z.string().max(500).optional().nullable(),
    // Desde la UI solo se permiten estos orígenes ("migracion" lo usan los scripts).
    origen: z.enum(["manual", "csv"]).default("manual"),
    items: z.array(transaccionItemSchema).min(1, "Se requiere al menos un item").max(300, "Máximo 300 productos por transacción"),
  })
  .superRefine((val, ctx) => {
    for (const [i, it] of val.items.entries()) {
      const needOrigin = val.tipo === "venta" || val.tipo === "traslado";
      const needDest = val.tipo === "compra" || val.tipo === "traslado";
      if (needOrigin && !it.ubicacion_origen_id) {
        ctx.addIssue({ path: ["items", i], code: "custom", message: "ubicacion_origen_id requerida" });
      }
      if (needDest && !it.ubicacion_destino_id) {
        ctx.addIssue({ path: ["items", i], code: "custom", message: "ubicacion_destino_id requerida" });
      }
    }
  });
export type TransaccionInput = z.infer<typeof transaccionSchema>;

export const ajusteInventarioSchema = z.object({
  producto_id: z.string().uuid(),
  ubicacion_id: z.string().uuid(),
  cantidad_nueva: z.number().int().nonnegative(),
  motivo: z.enum(["conteo_fisico", "merma", "rotura", "correccion", "ingreso_inicial", "otro"]),
  notas: z.string().max(500).optional().nullable(),
});
export type AjusteInventarioInput = z.infer<typeof ajusteInventarioSchema>;

// Fila esperada del CSV de carga masiva de transacciones que haremos en el sitio.
export const csvTransaccionRowSchema = z.object({
  fecha: z.string(),
  tipo: z.enum(["compra", "venta"]),
  codigo_producto: z.string().trim().min(1),
  ubicacion: z.string().trim().min(1),
  cantidad: z.coerce.number().int().positive(),
  precio_unitario: z.coerce.number().nonnegative(),
  lista_precio: z.string().optional().nullable(),
  notas: z.string().optional().nullable(),
});
export type CsvTransaccionRow = z.infer<typeof csvTransaccionRowSchema>;
