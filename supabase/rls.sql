-- ============================================================================
-- Prime Padel ERP — Row Level Security (RLS)
-- ============================================================================
-- Estrategia: TODAS las lecturas y escrituras del sistema pasan por server
-- actions y server components que usan el cliente con `service_role_key`
-- (ver lib/supabase/admin-server.ts). El service_role bypasea RLS por diseño.
--
-- Por lo tanto, la postura aquí es "deny all" para cualquier acceso vía la
-- API REST con la `publishable_key` (la que llega al navegador). Si alguien
-- intenta hacer GET /rest/v1/transacciones desde DevTools del navegador,
-- la respuesta será un array vacío en lugar de los datos reales.
--
-- Esto cierra el agujero #1 sin requerir cambios en el código de la app.
--
-- Ejecutar en el SQL Editor de Supabase. Idempotente: re-ejecutable sin daño.
-- ============================================================================

set client_min_messages to warning;

alter table categorias                  enable row level security;
alter table impuestos                   enable row level security;
alter table listas_precios              enable row level security;
alter table ubicaciones                 enable row level security;
alter table productos                   enable row level security;
alter table precios_producto            enable row level security;
alter table stock_por_ubicacion         enable row level security;
alter table transacciones               enable row level security;
alter table transaccion_items           enable row level security;
alter table ajustes_inventario          enable row level security;
alter table ventas_historicas_mensuales enable row level security;
alter table perfiles                    enable row level security;

-- Forzar RLS también para los dueños de la tabla (paranoid mode).
-- Sin esto, el rol que creó la tabla sigue pudiendo leer/escribir.
alter table categorias                  force row level security;
alter table impuestos                   force row level security;
alter table listas_precios              force row level security;
alter table ubicaciones                 force row level security;
alter table productos                   force row level security;
alter table precios_producto            force row level security;
alter table stock_por_ubicacion         force row level security;
alter table transacciones               force row level security;
alter table transaccion_items           force row level security;
alter table ajustes_inventario          force row level security;
alter table ventas_historicas_mensuales force row level security;
alter table perfiles                    force row level security;

-- ----------------------------------------------------------------------------
-- Notas:
-- ----------------------------------------------------------------------------
-- 1) NO se crean políticas (CREATE POLICY) intencionalmente. Sin políticas,
--    cualquier consulta vía la `publishable_key` (rol `anon` o `authenticated`)
--    devuelve 0 filas para SELECT y rechaza INSERT/UPDATE/DELETE.
--
-- 2) El cliente del navegador NUNCA consulta estas tablas directamente; toda
--    la lógica de negocio pasa por server components (page.tsx) o server
--    actions (actions.ts) que usan `sbAdmin()`.
--
-- 3) `auth.users` y `auth.sessions` (gestionadas por Supabase Auth) NO se tocan
--    aquí — Supabase ya las protege con sus propias políticas.
--
-- 4) Si en el futuro queremos exponer alguna lectura al cliente directamente
--    (ej. un endpoint público de catálogo), agregamos una policy específica
--    aquí, no quitamos RLS.
--
-- 5) RLS NO cubre vistas ni funciones RPC: ejecutar también
--    supabase/security_hardening.sql (security_invoker en vistas, EXECUTE
--    solo para service_role y privilegios por defecto cerrados).
-- ============================================================================
