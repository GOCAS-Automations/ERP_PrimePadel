-- ============================================================================
-- Migración: separar costo_unitario y precio_unitario en transaccion_items
-- ============================================================================
-- Antes: solo guardábamos `precio_unitario`. Para compras y traslados eso era
-- el costo; para ventas era el precio al cliente y NO se guardaba el costo.
--
-- Ahora: guardamos ambos. Esto permite calcular margen real de ventas y
-- preservar el costo histórico al momento de la transacción (no se pierde si
-- el costo del producto en el catálogo cambia después).
--
-- Backfill:
--   - compra:   costo_unitario = precio_unitario (era el costo del proveedor)
--   - traslado: costo_unitario = precio_unitario (era costo de referencia)
--   - venta:    costo_unitario = costo actual del producto en el catálogo
--               (best-effort; si el producto fue eliminado, queda en 0)
--
-- Ejecutar UNA SOLA VEZ en el SQL Editor de Supabase. Idempotente.
-- ============================================================================

set client_min_messages to warning;

-- 1) Añadir columna si no existe.
alter table transaccion_items
  add column if not exists costo_unitario numeric(14,2) not null default 0
  check (costo_unitario >= 0);

-- 2) Backfill de filas existentes (solo donde costo_unitario sigue en 0,
--    para no sobrescribir valores ya importados o ajustados manualmente).
update transaccion_items ti
   set costo_unitario = ti.precio_unitario
  from transacciones t
 where ti.transaccion_id = t.id
   and t.tipo in ('compra','traslado')
   and ti.costo_unitario = 0;

update transaccion_items ti
   set costo_unitario = coalesce(p.costo_unitario, 0)
  from transacciones t,
       productos p
 where ti.transaccion_id = t.id
   and ti.producto_id = p.id
   and t.tipo = 'venta'
   and ti.costo_unitario = 0;

-- 3) Re-crear la función registrar_transaccion para aceptar costo_unitario
--    en cada item del jsonb.
drop function if exists registrar_transaccion(text, timestamptz, uuid, text, text, jsonb) cascade;

create or replace function registrar_transaccion(
  p_tipo     text,
  p_fecha    timestamptz,
  p_usuario  uuid,
  p_notas    text,
  p_origen   text,
  p_items    jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id       uuid;
  v_total    numeric(14,2) := 0;
  v_item     jsonb;
  v_prod     uuid;
  v_orig     uuid;
  v_dest     uuid;
  v_cant     integer;
  v_precio   numeric(14,2);
  v_costo    numeric(14,2);
  v_subtotal numeric(14,2);
  v_lista    uuid;
  v_stock    integer;
  v_inv      boolean;
begin
  if p_tipo not in ('compra','venta','traslado') then
    raise exception 'tipo invalido: %', p_tipo;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'se requiere al menos un item';
  end if;

  insert into transacciones(tipo, fecha, usuario_id, total, notas, origen)
  values (p_tipo, coalesce(p_fecha, now()), p_usuario, 0, p_notas, coalesce(p_origen,'manual'))
  returning id into v_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_prod   := (v_item->>'producto_id')::uuid;
    v_orig   := nullif(v_item->>'ubicacion_origen_id','')::uuid;
    v_dest   := nullif(v_item->>'ubicacion_destino_id','')::uuid;
    v_cant   := (v_item->>'cantidad')::integer;
    v_precio := coalesce((v_item->>'precio_unitario')::numeric, 0);
    -- Si no se pasa costo_unitario, default = precio_unitario (compra/traslado lo cumplen).
    v_costo  := coalesce((v_item->>'costo_unitario')::numeric, v_precio);
    v_lista  := nullif(v_item->>'lista_precio_id','')::uuid;

    if v_cant is null or v_cant <= 0 then
      raise exception 'cantidad invalida para producto %', v_prod;
    end if;

    select es_inventariable into v_inv from productos where id = v_prod;
    if v_inv is null then
      raise exception 'producto % no existe', v_prod;
    end if;

    v_subtotal := v_cant * v_precio;
    v_total    := v_total + v_subtotal;

    insert into transaccion_items(
      transaccion_id, producto_id,
      ubicacion_origen_id, ubicacion_destino_id,
      cantidad, precio_unitario, costo_unitario, subtotal, lista_precio_id
    ) values (
      v_id, v_prod, v_orig, v_dest, v_cant, v_precio, v_costo, v_subtotal, v_lista
    );

    -- Servicios no mueven stock.
    if not v_inv then
      continue;
    end if;

    if p_tipo = 'compra' then
      if v_dest is null then raise exception 'compra requiere ubicacion_destino_id'; end if;
      insert into stock_por_ubicacion(producto_id, ubicacion_id, cantidad)
        values (v_prod, v_dest, 0)
        on conflict (producto_id, ubicacion_id) do nothing;
      update stock_por_ubicacion
        set cantidad = cantidad + v_cant, updated_at = now()
        where producto_id = v_prod and ubicacion_id = v_dest;

    elsif p_tipo = 'venta' then
      if v_orig is null then raise exception 'venta requiere ubicacion_origen_id'; end if;
      select cantidad into v_stock from stock_por_ubicacion
        where producto_id = v_prod and ubicacion_id = v_orig for update;
      if v_stock is null or v_stock < v_cant then
        raise exception 'stock insuficiente: producto %, ubicacion %, disponible %, solicitado %',
          v_prod, v_orig, coalesce(v_stock,0), v_cant;
      end if;
      update stock_por_ubicacion
        set cantidad = cantidad - v_cant, updated_at = now()
        where producto_id = v_prod and ubicacion_id = v_orig;

    elsif p_tipo = 'traslado' then
      if v_orig is null or v_dest is null then
        raise exception 'traslado requiere ubicacion_origen_id y ubicacion_destino_id';
      end if;
      if v_orig = v_dest then
        raise exception 'traslado: origen y destino no pueden ser iguales';
      end if;
      select cantidad into v_stock from stock_por_ubicacion
        where producto_id = v_prod and ubicacion_id = v_orig for update;
      if v_stock is null or v_stock < v_cant then
        raise exception 'stock insuficiente en origen';
      end if;
      update stock_por_ubicacion
        set cantidad = cantidad - v_cant, updated_at = now()
        where producto_id = v_prod and ubicacion_id = v_orig;
      insert into stock_por_ubicacion(producto_id, ubicacion_id, cantidad)
        values (v_prod, v_dest, 0)
        on conflict (producto_id, ubicacion_id) do nothing;
      update stock_por_ubicacion
        set cantidad = cantidad + v_cant, updated_at = now()
        where producto_id = v_prod and ubicacion_id = v_dest;
    end if;
  end loop;

  update transacciones set total = v_total where id = v_id;
  return v_id;
end;
$$;

-- 4) La función recreada vuelve a heredar EXECUTE para public/anon/authenticated:
--    restringirla a service_role (ver supabase/security_hardening.sql).
revoke all on function registrar_transaccion(text, timestamptz, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function registrar_transaccion(text, timestamptz, uuid, text, text, jsonb) to service_role;
