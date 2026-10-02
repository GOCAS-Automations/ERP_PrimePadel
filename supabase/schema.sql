-- ============================================================================
-- Prime Padel ERP — Esquema v2 (modelo final)
-- ============================================================================
-- Ejecutar COMPLETO en Supabase SQL Editor. Reemplaza cualquier versión anterior.
-- Seguro para re-ejecutar: los DROP CASCADE al inicio limpian todo primero.
--
-- Nota: este script NO borra la tabla auth.users ni los usuarios de Supabase Auth;
-- solo borra y recrea las tablas del dominio de negocio.
-- ============================================================================

set client_min_messages to warning;

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- 0. LIMPIEZA (drop cascade para permitir re-ejecución)
-- ----------------------------------------------------------------------------
drop view  if exists v_stock_total cascade;
drop view  if exists v_producto_stock_total cascade;
drop table if exists ajustes_inventario cascade;
drop table if exists ventas_historicas_mensuales cascade;
drop table if exists transaccion_items cascade;
drop table if exists transacciones cascade;
drop table if exists stock_por_ubicacion cascade;
drop table if exists precios_producto cascade;
drop table if exists productos cascade;
drop table if exists listas_precios cascade;
drop table if exists impuestos cascade;
drop table if exists categorias cascade;
drop table if exists ubicaciones cascade;
drop table if exists perfiles cascade;
drop function if exists registrar_transaccion(text, timestamptz, uuid, text, jsonb) cascade;
drop function if exists registrar_ajuste_inventario(uuid, uuid, integer, text, text, uuid) cascade;
drop function if exists touch_updated_at() cascade;

-- ----------------------------------------------------------------------------
-- 1. HELPER: trigger genérico de updated_at
-- ----------------------------------------------------------------------------
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 2. CATÁLOGOS MAESTROS
-- ----------------------------------------------------------------------------

-- 2.1 Categorías
create table categorias (
  id           uuid primary key default gen_random_uuid(),
  nombre       text not null unique,
  descripcion  text,
  orden        integer not null default 0,
  activa       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger trg_categorias_updated before update on categorias
  for each row execute function touch_updated_at();

-- 2.2 Impuestos (IVA, Impoconsumo, etc.)
create table impuestos (
  id            uuid primary key default gen_random_uuid(),
  codigo        text not null unique,            -- 'IVA_19', 'IMPOCONSUMO_8', 'NINGUNO'
  nombre        text not null,                   -- 'IVA 19%'
  tipo          text not null check (tipo in ('iva','impoconsumo','ninguno','otro')),
  porcentaje    numeric(5,2) not null default 0 check (porcentaje >= 0 and porcentaje <= 100),
  codigo_origen text,                            -- valor exacto del CSV de Alegra, p.ej. '1-IVA 19%'
  activo        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- 2.3 Tarifas / Listas de precios (tipos de cliente / canales de venta)
-- UI: se muestra como "Tarifas". Internamente sigue siendo listas_precios.
create table listas_precios (
  id                   uuid primary key default gen_random_uuid(),
  codigo               text not null unique,              -- 'DETAL', 'STAFF_PRIME', 'KEVIN_GARCIA'
  nombre               text not null,                     -- 'Detal consumidor final'
  descripcion          text,
  es_default           boolean not null default false,
  orden                integer not null default 0,
  activa               boolean not null default true,
  -- Descuento aplicado al precio Detal cuando un producto no tiene precio
  -- configurado para esta tarifa. 0 = sin descuento (igual al Detal).
  descuento_porcentaje numeric(5,2) not null default 0
                       check (descuento_porcentaje >= 0 and descuento_porcentaje <= 100),
  created_at           timestamptz not null default now()
);
create unique index uq_listas_precios_default on listas_precios(es_default) where es_default = true;

-- 2.4 Ubicaciones físicas (bodega, nevera, barra, etc.)
create table ubicaciones (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null unique,
  tipo        text not null check (tipo in ('bodega','nevera','barra','vitrina','oficina','otro')),
  descripcion text,
  orden       integer not null default 0,
  activa      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_ubicaciones_updated before update on ubicaciones
  for each row execute function touch_updated_at();

-- ----------------------------------------------------------------------------
-- 3. PRODUCTOS Y SERVICIOS
-- ----------------------------------------------------------------------------

create table productos (
  id                     uuid primary key default gen_random_uuid(),
  codigo                 text unique,              -- SKU de Alegra; único si existe
  nombre                 text not null,
  tipo                   text not null check (tipo in ('producto','servicio')),
  categoria_id           uuid references categorias(id) on delete restrict,
  es_inventariable       boolean not null default true,
  stock_minimo_alerta    integer not null default 0 check (stock_minimo_alerta >= 0),
  costo_unitario         numeric(14,2) not null default 0 check (costo_unitario >= 0),
  impuesto_id            uuid references impuestos(id) on delete restrict,
  incluye_impuesto_en_precio boolean not null default true,
  unidad_medida          text default 'unidad',
  descripcion_larga      text,
  referencia_fabrica     text,
  codigo_barras          text,
  marca                  text,
  modelo                 text,
  visible_en_factura     boolean not null default true,
  activo                 boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- Un servicio no puede ser inventariable.
  constraint chk_servicio_no_inventariable
    check (tipo = 'producto' or es_inventariable = false)
);
create index idx_productos_categoria on productos(categoria_id);
create index idx_productos_tipo on productos(tipo);
create index idx_productos_activo on productos(activo) where activo = true;
create index idx_productos_inventariable on productos(es_inventariable) where es_inventariable = true;
create trigger trg_productos_updated before update on productos
  for each row execute function touch_updated_at();

-- 3.1 Precios por lista (N-a-N entre productos y listas_precios)
create table precios_producto (
  producto_id      uuid not null references productos(id) on delete cascade,
  lista_precio_id  uuid not null references listas_precios(id) on delete restrict,
  precio           numeric(14,2) not null check (precio >= 0),
  updated_at       timestamptz not null default now(),
  primary key (producto_id, lista_precio_id)
);
create index idx_precios_lista on precios_producto(lista_precio_id);
create trigger trg_precios_updated before update on precios_producto
  for each row execute function touch_updated_at();

-- ----------------------------------------------------------------------------
-- 4. STOCK POR UBICACIÓN (fuente de verdad)
-- ----------------------------------------------------------------------------

create table stock_por_ubicacion (
  producto_id  uuid not null references productos(id) on delete cascade,
  ubicacion_id uuid not null references ubicaciones(id) on delete restrict,
  cantidad     integer not null default 0 check (cantidad >= 0),
  updated_at   timestamptz not null default now(),
  primary key (producto_id, ubicacion_id)
);
create index idx_stock_ubicacion on stock_por_ubicacion(ubicacion_id);
create index idx_stock_producto_cant on stock_por_ubicacion(producto_id, cantidad);
create trigger trg_stock_updated before update on stock_por_ubicacion
  for each row execute function touch_updated_at();

-- 4.1 Vista: cantidad total y valoración por producto
-- security_invoker: la vista respeta el RLS de quien consulta (sin esto, una
-- vista corre con permisos de su dueño y expone los datos a la key pública).
create or replace view v_stock_total with (security_invoker = true) as
select
  p.id                                 as producto_id,
  p.codigo,
  p.nombre,
  p.tipo,
  p.es_inventariable,
  p.activo,
  p.stock_minimo_alerta,
  coalesce(sum(s.cantidad), 0)         as cantidad_total,
  p.costo_unitario,
  coalesce(sum(s.cantidad), 0) * p.costo_unitario as valor_total_costo,
  case
    when coalesce(sum(s.cantidad), 0) = 0 then 'sin_stock'
    when coalesce(sum(s.cantidad), 0) <= p.stock_minimo_alerta then 'stock_bajo'
    else 'ok'
  end as estado_stock
from productos p
left join stock_por_ubicacion s on s.producto_id = p.id
where p.es_inventariable
group by p.id;

-- ----------------------------------------------------------------------------
-- 5. USUARIOS / PERFILES (se integra con auth.users cuando activemos login)
-- ----------------------------------------------------------------------------

create table perfiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  nombre     text not null,
  rol        text not null check (rol in ('maestro','admin','recepcion')),
  activo     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_perfiles_updated before update on perfiles
  for each row execute function touch_updated_at();

-- ----------------------------------------------------------------------------
-- 6. TRANSACCIONES (compras, ventas, traslados)
-- ----------------------------------------------------------------------------

create table transacciones (
  id              uuid primary key default gen_random_uuid(),
  tipo            text not null check (tipo in ('compra','venta','traslado')),
  fecha           timestamptz not null default now(),
  usuario_id      uuid references auth.users(id) on delete set null,  -- quién la registró
  total           numeric(14,2) not null default 0 check (total >= 0),
  notas           text,
  origen          text not null default 'manual' check (origen in ('manual','csv','api','migracion')),
  -- Última edición (si aplica): preserva usuario_id como creador original.
  actualizado_en  timestamptz,
  actualizado_por uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index idx_transacciones_fecha on transacciones(fecha desc);
create index idx_transacciones_tipo on transacciones(tipo);
create index idx_transacciones_usuario on transacciones(usuario_id);

create table transaccion_items (
  id                    uuid primary key default gen_random_uuid(),
  transaccion_id        uuid not null references transacciones(id) on delete cascade,
  producto_id           uuid not null references productos(id) on delete restrict,
  -- Ubicaciones: compra usa destino, venta usa origen, traslado usa ambas.
  ubicacion_origen_id   uuid references ubicaciones(id) on delete restrict,
  ubicacion_destino_id  uuid references ubicaciones(id) on delete restrict,
  cantidad              integer not null check (cantidad > 0),
  precio_unitario       numeric(14,2) not null check (precio_unitario >= 0),
  -- Costo unitario al momento de la transacción (snapshot, no se refresca al
  -- cambiar el costo del producto en el catálogo). En venta puede diferir de
  -- precio_unitario (margen); en compra y traslado coincide con precio_unitario.
  costo_unitario        numeric(14,2) not null default 0 check (costo_unitario >= 0),
  subtotal              numeric(14,2) not null check (subtotal >= 0),
  lista_precio_id       uuid references listas_precios(id) on delete set null
);
create index idx_items_transaccion on transaccion_items(transaccion_id);
create index idx_items_producto on transaccion_items(producto_id);
create index idx_items_ubic_origen on transaccion_items(ubicacion_origen_id);
create index idx_items_ubic_destino on transaccion_items(ubicacion_destino_id);

-- ----------------------------------------------------------------------------
-- 7. AJUSTES DE INVENTARIO (conteo físico, mermas, correcciones)
-- ----------------------------------------------------------------------------

create table ajustes_inventario (
  id                uuid primary key default gen_random_uuid(),
  producto_id       uuid not null references productos(id) on delete restrict,
  ubicacion_id      uuid not null references ubicaciones(id) on delete restrict,
  cantidad_antes    integer not null check (cantidad_antes >= 0),
  cantidad_despues  integer not null check (cantidad_despues >= 0),
  diferencia        integer generated always as (cantidad_despues - cantidad_antes) stored,
  motivo            text not null check (motivo in
                     ('conteo_fisico','merma','rotura','correccion','ingreso_inicial','otro')),
  notas             text,
  usuario_id        uuid references auth.users(id) on delete set null,
  fecha             timestamptz not null default now()
);
create index idx_ajustes_producto on ajustes_inventario(producto_id);
create index idx_ajustes_ubicacion on ajustes_inventario(ubicacion_id);
create index idx_ajustes_fecha on ajustes_inventario(fecha desc);
create index idx_ajustes_motivo on ajustes_inventario(motivo);

-- ----------------------------------------------------------------------------
-- 8. HISTÓRICO DE VENTAS MENSUALES (agregado desde reporte Alegra)
-- ----------------------------------------------------------------------------

create table ventas_historicas_mensuales (
  producto_id        uuid not null references productos(id) on delete cascade,
  anio               integer not null check (anio between 2020 and 2100),
  mes                integer not null check (mes between 1 and 12),
  cantidad_vendida   integer not null default 0,
  valor_bruto        numeric(14,2) not null default 0,
  descuento          numeric(14,2) not null default 0,
  subtotal           numeric(14,2) not null default 0,
  impuesto_cargo     numeric(14,2) not null default 0,
  impuesto_retencion numeric(14,2) not null default 0,
  total              numeric(14,2) not null default 0,
  fuente             text not null default 'alegra' check (fuente in ('alegra','manual','otro')),
  importado_en       timestamptz not null default now(),
  primary key (producto_id, anio, mes)
);
create index idx_ventas_hist_periodo on ventas_historicas_mensuales(anio desc, mes desc);
create index idx_ventas_hist_producto on ventas_historicas_mensuales(producto_id);

-- ----------------------------------------------------------------------------
-- 9. FUNCIÓN RPC: registrar transacción atómica
-- ----------------------------------------------------------------------------
-- Uso: rpc('registrar_transaccion', { p_tipo, p_fecha, p_usuario, p_notas, p_origen, p_items })
-- p_items = jsonb array; cada item: { producto_id, ubicacion_origen_id, ubicacion_destino_id,
--                                      cantidad, precio_unitario, lista_precio_id }
-- Reglas:
--   compra   → descuenta lógicamente de proveedor (fuera de sistema) y suma en ubicacion_destino_id.
--   venta    → descuenta de ubicacion_origen_id (valida stock) y suma a ingresos.
--   traslado → mueve de origen a destino en la misma transacción.
-- Productos no inventariables solo registran la venta; no tocan stock.

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

-- ----------------------------------------------------------------------------
-- 10. FUNCIÓN RPC: registrar ajuste de inventario (conteo físico, merma...)
-- ----------------------------------------------------------------------------

create or replace function registrar_ajuste_inventario(
  p_producto        uuid,
  p_ubicacion       uuid,
  p_cantidad_nueva  integer,
  p_motivo          text,
  p_notas           text,
  p_usuario         uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_antes  integer;
  v_id     uuid;
begin
  if p_cantidad_nueva < 0 then
    raise exception 'cantidad_nueva no puede ser negativa';
  end if;

  insert into stock_por_ubicacion(producto_id, ubicacion_id, cantidad)
    values (p_producto, p_ubicacion, 0)
    on conflict (producto_id, ubicacion_id) do nothing;

  select cantidad into v_antes from stock_por_ubicacion
    where producto_id = p_producto and ubicacion_id = p_ubicacion
    for update;

  update stock_por_ubicacion
    set cantidad = p_cantidad_nueva, updated_at = now()
    where producto_id = p_producto and ubicacion_id = p_ubicacion;

  insert into ajustes_inventario(
    producto_id, ubicacion_id, cantidad_antes, cantidad_despues,
    motivo, notas, usuario_id
  ) values (
    p_producto, p_ubicacion, coalesce(v_antes,0), p_cantidad_nueva,
    p_motivo, p_notas, p_usuario
  ) returning id into v_id;

  return v_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 11. PRIVILEGIOS: solo service_role ejecuta las RPC y lee la vista.
--     Por defecto Postgres/Supabase dan EXECUTE a public/anon/authenticated,
--     lo que permitía llamar /rest/v1/rpc/* con la key pública.
-- ----------------------------------------------------------------------------
revoke all on function registrar_transaccion(text, timestamptz, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function registrar_ajuste_inventario(uuid, uuid, integer, text, text, uuid) from public, anon, authenticated;
revoke all on function touch_updated_at() from public, anon, authenticated;
grant execute on function registrar_transaccion(text, timestamptz, uuid, text, text, jsonb) to service_role;
grant execute on function registrar_ajuste_inventario(uuid, uuid, integer, text, text, uuid) to service_role;
revoke all on v_stock_total from public, anon, authenticated;
grant select on v_stock_total to service_role;

-- ----------------------------------------------------------------------------
-- 12. RLS: ejecutar después supabase/rls.sql y supabase/security_hardening.sql.
-- ----------------------------------------------------------------------------
