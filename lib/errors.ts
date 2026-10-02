// Traduce mensajes técnicos de Postgres / Supabase a mensajes
// entendibles para el usuario final (en español, sin jerga técnica).

const MAPPINGS: { test: RegExp; toMessage: (m: string) => string }[] = [
  {
    test: /cantidad_nueva no puede ser negativa/i,
    toMessage: () =>
      "No hay suficiente stock en la ubicación para revertir esta transacción. " +
      "Esto suele pasar cuando una compra antigua ya se vendió o se trasladó parcialmente. " +
      "Solución: el sistema acaba de detectar que el cambio es solo de precio/costo/notas; si ese era tu caso, vuelve a intentar — ya tenemos un atajo que no toca stock. " +
      "Si en cambio quieres cambiar la cantidad, primero registra una compra que reponga el faltante.",
  },
  {
    test: /stock insuficiente.*disponible (\d+), solicitado (\d+)/i,
    toMessage: (m) => {
      const match = m.match(/disponible (\d+), solicitado (\d+)/i);
      if (match) {
        return `Stock insuficiente: hay ${match[1]} unidades disponibles y estás intentando mover ${match[2]}.`;
      }
      return "Stock insuficiente en la ubicación de origen para esta operación.";
    },
  },
  {
    test: /stock insuficiente en origen/i,
    toMessage: () => "Stock insuficiente en la ubicación de origen del traslado.",
  },
  {
    test: /traslado.*origen y destino no pueden ser iguales/i,
    toMessage: () => "En un traslado, las ubicaciones de origen y destino deben ser distintas.",
  },
  {
    test: /traslado requiere ubicacion_origen_id/i,
    toMessage: () => "El traslado requiere indicar la ubicación de origen.",
  },
  {
    test: /traslado requiere ubicacion_destino_id/i,
    toMessage: () => "El traslado requiere indicar la ubicación de destino.",
  },
  {
    test: /venta requiere ubicacion_origen_id/i,
    toMessage: () => "La venta requiere indicar la ubicación de origen (de dónde sale el producto).",
  },
  {
    test: /compra requiere ubicacion_destino_id/i,
    toMessage: () => "La compra requiere indicar la ubicación de destino (a dónde llega el producto).",
  },
  {
    test: /producto.*no existe/i,
    toMessage: () => "Uno de los productos referenciados no existe o fue eliminado del catálogo.",
  },
  {
    test: /cantidad invalida/i,
    toMessage: () => "La cantidad debe ser un número entero mayor a cero.",
  },
  {
    test: /tipo invalido/i,
    toMessage: () => "El tipo de transacción no es válido (debe ser venta, compra o traslado).",
  },
  {
    test: /se requiere al menos un item/i,
    toMessage: () => "Debes agregar al menos un producto a la transacción.",
  },
  // Errores genéricos de Postgres
  {
    test: /duplicate key value.*unique constraint.*codigo/i,
    toMessage: () => "Ya existe un registro con ese código. Usa un código distinto.",
  },
  {
    test: /duplicate key value/i,
    toMessage: () => "Ya existe un registro con esos datos (debe ser único).",
  },
  {
    test: /violates foreign key constraint/i,
    toMessage: () => "No se puede eliminar este elemento porque hay otros registros que dependen de él.",
  },
  {
    test: /violates not-null constraint.*"([^"]+)"/i,
    toMessage: (m) => {
      const match = m.match(/violates not-null constraint.*"([^"]+)"/i);
      const campo = match ? humanizarNombreCampo(match[1]) : "un campo obligatorio";
      return `Falta llenar ${campo}.`;
    },
  },
  {
    test: /violates check constraint/i,
    toMessage: () => "Uno de los valores no cumple las reglas de validación (ej. cantidad negativa, porcentaje fuera de rango).",
  },
  {
    test: /column .* does not exist/i,
    toMessage: () =>
      "Error técnico interno: una columna referenciada no existe. Avísale al proveedor del software.",
  },
  {
    test: /permission denied|new row violates row-level security/i,
    toMessage: () => "No tienes permisos para realizar esta acción.",
  },
];

// Traduce nombres de columnas técnicas a etiquetas amigables.
const FIELD_LABELS: Record<string, string> = {
  cantidad_nueva: "la cantidad nueva del ajuste",
  cantidad_antes: "la cantidad anterior",
  cantidad_despues: "la cantidad nueva",
  cantidad: "la cantidad",
  precio_unitario: "el precio unitario",
  costo_unitario: "el costo unitario",
  ubicacion_id: "la ubicación",
  ubicacion_origen_id: "la ubicación de origen",
  ubicacion_destino_id: "la ubicación de destino",
  producto_id: "el producto",
  categoria_id: "la categoría",
  impuesto_id: "el impuesto",
  lista_precio_id: "la tarifa",
  fecha: "la fecha",
  tipo: "el tipo",
  motivo: "el motivo",
  nombre: "el nombre",
  codigo: "el código",
  descuento_porcentaje: "el descuento %",
  descripcion: "la descripción",
  orden: "el orden",
};

export function humanizarNombreCampo(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

export function humanizarError(msg: string | null | undefined): string {
  if (!msg) return "Ocurrió un error desconocido. Intenta de nuevo o avísale al administrador.";
  const s = String(msg);
  for (const { test, toMessage } of MAPPINGS) {
    if (test.test(s)) return toMessage(s);
  }
  // No exponer detalles internos (nombres de tablas/funciones, errores de PostgREST/JWT).
  if (/relation |column |syntax error|function .*\(|schema |PGRST|JWT|stack|at .*\.(js|ts):\d+/i.test(s)) {
    return "Ocurrió un error interno. Intenta de nuevo o avísale al administrador.";
  }
  // Limpia prefijos técnicos de Postgres si no hubo match.
  return s
    .replace(/^Error: /i, "")
    .replace(/^PostgrestError: /i, "")
    .replace(/^new row for relation "[^"]+" /i, "")
    .trim();
}
