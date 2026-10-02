"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { parseCSV, agruparPorTicket, type Catalogo, type ParseResult } from "@/lib/csv/transacciones";
import { importarTransacciones, descargarPlantillaCSV } from "./actions";
import { formatCOP, formatDate } from "@/lib/utils";

export function CargaMasivaClient({ catalogo, soloVentas }: { catalogo: Catalogo; soloVentas?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ParseResult | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);
  const [resumen, setResumen] = React.useState<{ creadas: number; fallidas: { ticket: string | null; razon: string }[] } | null>(null);

  async function descargarPlantilla() {
    setDownloading(true);
    const res = await descargarPlantillaCSV();
    setDownloading(false);
    if ("error" in res) {
      toast.push({ message: res.error, tone: "error" });
      return;
    }
    const blob = new Blob(["﻿" + res.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = res.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function onFile(file: File) {
    if (file.size > 5 * 1024 * 1024) {
      toast.push({ message: "El archivo supera 5 MB. Divídelo en archivos más pequeños.", tone: "error" });
      return;
    }
    setFileName(file.name);
    setResumen(null);
    const text = await file.text();
    // Recepción no puede usar "Otro" en la columna tarifa (precio personalizado);
    // admin/maestro sí. Esto solo cambia mensajes de error del parser.
    const parsed = parseCSV(text, catalogo, { permiteTarifaOtro: !soloVentas });
    // Si el usuario es recepción, marcamos las filas de compra como inválidas.
    if (soloVentas) {
      const movidos: typeof parsed.invalid = [];
      const validasFinal = parsed.valid.filter((r) => {
        if (r.tipo === "compra") {
          movidos.push({
            rowNumber: r.rowNumber,
            raw: { fecha: r.fecha, tipo: r.tipo, codigo_producto: r.producto_codigo, ubicacion: r.ubicacion_nombre, cantidad: String(r.cantidad) },
            errors: [`Tu rol no permite registrar compras (solo ventas y traslados).`],
          });
          return false;
        }
        return true;
      });
      setResult({ valid: validasFinal, invalid: [...parsed.invalid, ...movidos], total: parsed.total, ignoradas: parsed.ignoradas });
    } else {
      setResult(parsed);
    }
  }

  async function confirmar() {
    // Permitimos importar las filas válidas aunque haya filas con error
    // (las inválidas se omiten, no detienen la importación).
    if (!result || result.valid.length === 0) return;
    setSubmitting(true);
    const grupos = agruparPorTicket(result.valid);
    const res = await importarTransacciones(grupos);
    setSubmitting(false);
    setResumen({ creadas: res.creadas, fallidas: res.fallidas });
    if (res.fallidas.length === 0) {
      toast.push({ message: `${res.creadas} transacciones importadas`, tone: "success" });
    } else {
      toast.push({ message: `${res.creadas} creadas, ${res.fallidas.length} con error`, tone: "error" });
    }
    router.refresh();
  }

  function reset() {
    setFileName(null);
    setResult(null);
    setResumen(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const totalImporte = result?.valid.reduce((a, r) => a + r.cantidad * r.precio_unitario, 0) ?? 0;
  const gruposPreview = result ? agruparPorTicket(result.valid) : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Carga masiva de transacciones</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Sube un archivo CSV con múltiples ventas o compras. Ideal para cargar un fin de semana
            completo o migrar registros atrasados.{" "}
            <Link href="/transacciones" className="text-brand-orange hover:underline">Volver a transacciones →</Link>
          </p>
        </div>
      </div>

      {!result ? (
        <>
          <Card>
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-sm font-medium text-white">1. Descarga la plantilla</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  El CSV viene <strong>pre-llenado con una fila por cada producto</strong> y tipo de transacción permitido para tu rol.
                  Modifica solo las cantidades de los productos que efectivamente se movieron — las filas que dejes en 0 se ignoran al importar.
                </p>
              </div>
              <Button variant="outline" onClick={descargarPlantilla} disabled={downloading}>
                {downloading ? "Generando..." : "⬇ Descargar plantilla CSV"}
              </Button>
            </div>
          </Card>

          <Card>
            <p className="text-sm font-medium text-white">2. Llena el archivo</p>
            <p className="mt-1 text-xs text-muted-foreground">
              La plantilla ya trae una fila por cada producto. <strong className="text-white">Lo único que tienes que hacer es escribir la cantidad</strong> en los productos que se movieron. Las demás déjalas en 0.
            </p>

            <div className="mt-3 overflow-x-auto rounded border border-border">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Columna</th>
                    <th className="px-2 py-1.5 text-left">¿Qué va aquí?</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  <tr>
                    <td className="px-2 py-1.5 font-mono text-brand-orange">cantidad</td>
                    <td className="px-2 py-1.5 text-muted-foreground"><strong className="text-white">Lo único que debes llenar siempre.</strong> Entero positivo. Si la dejas en 0 (o vacía), esa fila se ignora.</td>
                  </tr>
                  <tr>
                    <td className="px-2 py-1.5 font-mono text-brand-orange">tarifa</td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      <strong className="text-white">Solo en filas de venta.</strong> Viene pre-llenada con la tarifa default (Detal). Puedes cambiarla por otra. Debe ser el <strong className="text-white">nombre exacto</strong> de una de las tarifas activas:{" "}
                      {(catalogo.tarifas ?? []).filter((t) => t.activa).map((t, idx, arr) => (
                        <span key={t.id}>
                          <code className="text-brand-orange">{t.nombre}</code>
                          {idx < arr.length - 1 ? ", " : "."}
                        </span>
                      ))}
                      {!soloVentas ? (
                        <>
                          {" "}También se acepta <code className="text-brand-orange">Otro</code> (precio personalizado); en ese caso debes llenar <code className="text-brand-orange">valor_unitario</code> con el precio cobrado al cliente.
                        </>
                      ) : (
                        <>
                          {" "}<strong className="text-yellow-300">Tu rol no permite</strong> usar "Otro": solo las tarifas de la lista.
                        </>
                      )}
                      {" "}En filas de compra/traslado esta columna se ignora.
                    </td>
                  </tr>
                  <tr>
                    <td className="px-2 py-1.5 font-mono text-brand-orange">valor_unitario</td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      En <strong className="text-white">venta</strong>: <strong className="text-yellow-300">se ignora</strong> si la tarifa es válida (el sistema toma el precio del catálogo). <strong>Solo se utiliza cuando la tarifa es <code className="text-brand-orange">Otro</code></strong>; en ese caso debes indicar el precio cobrado al cliente.<br />
                      En <strong className="text-white">compra/traslado</strong>: corresponde al costo unitario. Viene pre-llenado con el del catálogo; edítalo solo si fue distinto.
                    </td>
                  </tr>
                  <tr>
                    <td className="px-2 py-1.5 font-mono text-muted-foreground">nombre_producto</td>
                    <td className="px-2 py-1.5 text-muted-foreground">Solo referencia para que identifiques el producto. <strong className="text-white">No se usa</strong> para guardar (el mapeo es por código). No hace falta tocarla.</td>
                  </tr>
                  <tr>
                    <td className="px-2 py-1.5 font-mono text-muted-foreground">codigo_producto</td>
                    <td className="px-2 py-1.5 text-muted-foreground">El código (SKU) con el que el sistema identifica el producto. <strong className="text-white">No lo cambies.</strong></td>
                  </tr>
                  <tr>
                    <td className="px-2 py-1.5 font-mono text-muted-foreground">tipo</td>
                    <td className="px-2 py-1.5 text-muted-foreground"><code className="text-brand-orange">venta</code>, <code className="text-brand-orange">compra</code> o <code className="text-brand-orange">traslado</code> (ya viene puesto en cada fila).</td>
                  </tr>
                  <tr>
                    <td className="px-2 py-1.5 font-mono text-muted-foreground">fecha</td>
                    <td className="px-2 py-1.5 text-muted-foreground">Viene con la fecha de hoy. Acepta <code className="text-brand-orange">DD/MM/AAAA</code> o <code className="text-brand-orange">AAAA-MM-DD</code> (opcional con hora <code className="text-brand-orange">HH:MM</code>).</td>
                  </tr>
                  <tr>
                    <td className="px-2 py-1.5 font-mono text-muted-foreground">ubicacion</td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      De dónde sale (venta/traslado) o a dónde llega (compra). Debe ser el nombre <strong className="text-white">exacto</strong> de una de las ubicaciones activas:{" "}
                      {catalogo.ubicaciones.filter((u) => u.activa).map((u, idx, arr) => (
                        <span key={u.id}>
                          <code className="text-brand-orange">{u.nombre}</code>
                          {idx < arr.length - 1 ? ", " : "."}
                        </span>
                      ))}
                    </td>
                  </tr>
                  <tr>
                    <td className="px-2 py-1.5 font-mono text-muted-foreground">ubicacion_destino</td>
                    <td className="px-2 py-1.5 text-muted-foreground">Solo en filas de <strong className="text-white">traslado</strong>: a dónde llega el stock. Acepta los mismos valores que la columna <code className="text-brand-orange">ubicacion</code>.</td>
                  </tr>
                  <tr>
                    <td className="px-2 py-1.5 font-mono text-muted-foreground">notas / ticket</td>
                    <td className="px-2 py-1.5 text-muted-foreground">Opcionales. <code className="text-brand-orange">ticket</code> agrupa varias filas en una sola transacción (ej. una venta con varios productos al mismo cliente).</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="mt-3 rounded border border-brand-orange/40 bg-brand-orange/5 p-3 text-xs text-muted-foreground">
              <p className="font-semibold text-brand-orange">Recomendaciones</p>
              <ul className="mt-1 space-y-1">
                <li>• No borres ni reordenes los encabezados (la primera fila).</li>
                <li>• Puedes borrar las filas que no usarás, o simplemente dejarlas en cantidad 0.</li>
                <li>• Si agregas un producto con un código que no existe en el catálogo, esa fila se marcará con error — pero las filas válidas se importan igual.</li>
              </ul>
            </div>
          </Card>

          <Card>
            <p className="text-sm font-medium text-white">3. Sube el archivo</p>
            <div className="mt-3">
              <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border p-12 text-center hover:border-brand-orange">
                <p className="text-sm text-muted-foreground">Haz click o arrastra un archivo .csv aquí</p>
                <p className="text-xs text-muted-foreground">Máximo recomendado: 500 filas por archivo.</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
                />
              </label>
            </div>
          </Card>
        </>
      ) : resumen ? (
        // Pantalla de resultado final
        <Card>
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-white">Importación completada</h2>
              <p className="mt-1 text-sm text-muted-foreground">{fileName}</p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded border border-green-900/50 bg-green-950/20 p-3">
                <p className="text-xs uppercase text-green-300">Creadas</p>
                <p className="mt-1 text-3xl font-bold text-green-300">{resumen.creadas}</p>
              </div>
              <div className="rounded border border-red-900/50 bg-red-950/20 p-3">
                <p className="text-xs uppercase text-red-300">Con error</p>
                <p className="mt-1 text-3xl font-bold text-red-300">{resumen.fallidas.length}</p>
              </div>
            </div>

            {resumen.fallidas.length > 0 ? (
              <div>
                <p className="mb-2 text-sm font-medium text-white">Detalle de errores:</p>
                <div className="space-y-1 rounded border border-red-900/40 bg-red-950/10 p-3 text-xs">
                  {resumen.fallidas.map((f, i) => (
                    <div key={i} className="text-red-300">
                      {f.ticket ? <strong>Ticket {f.ticket}: </strong> : null}
                      {f.razon}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex gap-2 pt-2">
              <Button onClick={reset}>Subir otro archivo</Button>
              <Link href="/transacciones">
                <Button variant="outline">Ver lista de transacciones</Button>
              </Link>
            </div>
          </div>
        </Card>
      ) : (
        // Pantalla de preview
        <div className="space-y-4">
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-white">📄 {fileName}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {result.total + result.ignoradas} filas leídas · {result.valid.length} válidas · {result.invalid.length} con error · {result.ignoradas} ignoradas (cantidad 0)
                  {result.valid.length > 0 ? (
                    <>
                      {" "}· se crearán <strong className="text-white">{gruposPreview.length}</strong> transacciones
                      {" "}por <strong className="text-white">{formatCOP(totalImporte)}</strong>
                    </>
                  ) : null}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={reset}>Cambiar archivo</Button>
                <Button
                  onClick={confirmar}
                  disabled={submitting || result.valid.length === 0}
                >
                  {submitting ? "Importando..." : `Importar ${gruposPreview.length} transacc. válidas`}
                </Button>
              </div>
            </div>
            {result.invalid.length > 0 ? (
              <p className="mt-3 rounded border border-yellow-900/40 bg-yellow-950/20 p-2 text-xs text-yellow-300">
                Hay {result.invalid.length} fila(s) con error. Se importarán <strong>solo las {result.valid.length} válidas</strong> — las que tienen error se omitirán. Revisa la lista de abajo si quieres corregir el CSV antes.
              </p>
            ) : null}
          </Card>

          {result.invalid.length > 0 ? (
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-red-300">Filas con error ({result.invalid.length})</h2>
              <div className="overflow-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>Fila</TH>
                      <TH>Fecha</TH>
                      <TH>Tipo</TH>
                      <TH>Código</TH>
                      <TH>Ubicación</TH>
                      <TH className="text-right">Cantidad</TH>
                      <TH>Errores</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {result.invalid.map((row) => (
                      <TR key={row.rowNumber} className="bg-red-950/10">
                        <TD className="text-muted-foreground">{row.rowNumber}</TD>
                        <TD className="text-muted-foreground">{row.raw.fecha ?? "—"}</TD>
                        <TD className="text-muted-foreground">{row.raw.tipo ?? "—"}</TD>
                        <TD className="text-muted-foreground">{row.raw.codigo_producto ?? "—"}</TD>
                        <TD className="text-muted-foreground">{row.raw.ubicacion ?? "—"}</TD>
                        <TD className="text-right text-muted-foreground">{row.raw.cantidad ?? "—"}</TD>
                        <TD>
                          <ul className="space-y-0.5 text-xs text-red-300">
                            {row.errors.map((e, i) => <li key={i}>• {e}</li>)}
                          </ul>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </Card>
          ) : null}

          {result.valid.length > 0 ? (
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-green-300">Filas válidas ({result.valid.length})</h2>
              <div className="max-h-96 overflow-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>Fila</TH>
                      <TH>Fecha</TH>
                      <TH>Tipo</TH>
                      <TH>Producto</TH>
                      <TH>Ubicación</TH>
                      <TH className="text-right">Cant.</TH>
                      <TH className="text-right" title="Para ventas: precio al cliente. Para compras: costo unitario.">
                        Precio / Costo
                      </TH>
                      <TH>Tarifa</TH>
                      <TH>Ticket</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {result.valid.map((r) => (
                      <TR key={r.rowNumber}>
                        <TD className="text-muted-foreground">{r.rowNumber}</TD>
                        <TD className="text-xs text-muted-foreground">{formatDate(r.fecha)}</TD>
                        <TD>
                          {r.tipo === "venta"
                            ? <Badge tone="green">Venta</Badge>
                            : r.tipo === "compra"
                              ? <Badge tone="blue">Compra</Badge>
                              : <Badge tone="yellow">Traslado</Badge>}
                        </TD>
                        <TD className="text-white">
                          <span className="mr-2 font-mono text-xs text-muted-foreground">{r.producto_codigo}</span>
                          {r.producto_nombre}
                        </TD>
                        <TD className="text-muted-foreground">
                          {r.tipo === "traslado"
                            ? <span>{r.ubicacion_nombre} → {r.ubicacion_destino_nombre}</span>
                            : r.ubicacion_nombre}
                        </TD>
                        <TD className="text-right font-mono">{r.cantidad}</TD>
                        <TD className="text-right font-mono">{formatCOP(r.precio_unitario)}</TD>
                        <TD className="text-xs">
                          {r.tipo === "venta"
                            ? (r.lista_precio_id
                                ? <Badge tone="gray">{r.tarifa_nombre}</Badge>
                                : <span className="italic text-muted-foreground">Otro / Personalizado</span>)
                            : <span className="text-muted-foreground">—</span>}
                        </TD>
                        <TD className="text-xs text-muted-foreground">{r.ticket ?? "—"}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </Card>
          ) : null}
        </div>
      )}
    </div>
  );
}
