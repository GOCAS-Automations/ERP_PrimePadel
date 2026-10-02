import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { sbAdmin } from "@/lib/supabase/admin-server";

// Latido para que Supabase (plan gratis) no pause el proyecto por inactividad.
// Lo invoca el cron de Vercel (ver vercel.json), que envía
// `Authorization: Bearer $CRON_SECRET`. Sin ese secreto responde 401.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function autorizado(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const recibido = Buffer.from(request.headers.get("authorization") ?? "");
  const esperado = Buffer.from(`Bearer ${secret}`);
  return recibido.length === esperado.length && timingSafeEqual(recibido, esperado);
}

export async function GET(request: Request) {
  if (!autorizado(request)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  // Consulta real a Postgres (cuenta como actividad de la base de datos).
  const { error } = await sbAdmin().from("categorias").select("id").limit(1);
  if (error) {
    console.error("[heartbeat] fallo consultando Supabase:", error.message);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ts: new Date().toISOString() });
}
