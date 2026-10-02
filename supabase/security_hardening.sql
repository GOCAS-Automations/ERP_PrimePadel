-- ============================================================================
-- Prime Padel ERP — Endurecimiento de seguridad de la base de datos
-- ============================================================================
-- Ejecutar COMPLETO en el SQL Editor de Supabase. Idempotente: se puede
-- re-ejecutar sin daño (y conviene hacerlo después de cualquier migración que
-- recree funciones o vistas).
--
-- Contexto: la app lee y escribe SOLO con la service_role key desde el
-- servidor (lib/supabase/admin-server.ts). La key pública (anon /
-- publishable) viaja al navegador y solo se usa para Supabase Auth. Por eso
-- anon/authenticated NO necesitan ningún privilegio sobre el esquema public.
--
-- Hallazgos que corrige (verificados con la key pública vía /rest/v1):
--   1. La vista v_stock_total devolvía el catálogo completo (códigos, nombres,
--      costo_unitario, stock) porque las vistas por defecto se ejecutan con
--      los permisos de su dueño e ignoran RLS.
--   2. Las funciones SECURITY DEFINER registrar_transaccion y
--      registrar_ajuste_inventario eran ejecutables por anon vía
--      /rest/v1/rpc → cualquiera podía crear transacciones o fijar stock.
-- ============================================================================

set client_min_messages to warning;

-- ----------------------------------------------------------------------------
-- 1. RLS habilitado y forzado en TODAS las tablas del esquema public
--    (sin políticas = deny-all para anon/authenticated; service_role bypasea).
-- ----------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select c.relname
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    execute format('alter table public.%I enable row level security', r.relname);
    execute format('alter table public.%I force row level security', r.relname);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 2. Vistas: respetar RLS del que consulta (security_invoker) y sin acceso
--    para anon/authenticated.
-- ----------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select c.relname, c.relkind
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('v', 'm')
  loop
    if r.relkind = 'v' then
      execute format('alter view public.%I set (security_invoker = true)', r.relname);
    end if;
    execute format('revoke all on public.%I from public, anon, authenticated', r.relname);
    execute format('grant select on public.%I to service_role', r.relname);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Tablas y secuencias: quitar privilegios a anon/authenticated
--    (defensa en profundidad además de RLS; también cierra /graphql/v1).
-- ----------------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant  all on all tables    in schema public to service_role;
grant  all on all sequences in schema public to service_role;

-- ----------------------------------------------------------------------------
-- 4. Funciones: solo service_role puede ejecutarlas (incluye las RPC
--    SECURITY DEFINER). search_path fijo para evitar secuestro de nombres.
-- ----------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.prokind = 'f'
             and not exists (select 1 from pg_depend d
                             where d.objid = p.oid and d.deptype = 'e') -- excluye funciones de extensiones
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    execute format('alter function %s set search_path = public, pg_temp', r.sig);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 5. Objetos FUTUROS creados por postgres en public: sin privilegios por
--    defecto para anon/authenticated (evita que una migración nueva vuelva a
--    exponer una tabla, vista o función).
-- ----------------------------------------------------------------------------
alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from public, anon, authenticated;
alter default privileges for role postgres in schema public grant  all on tables    to service_role;
alter default privileges for role postgres in schema public grant  all on sequences to service_role;
alter default privileges for role postgres in schema public grant  execute on functions to service_role;

-- Nadie salvo el dueño crea objetos en public.
revoke create on schema public from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 6. Verificación: debe devolver 0 filas. Si aparece algo, sigue expuesto.
-- ----------------------------------------------------------------------------
select 'funcion' as tipo, p.oid::regprocedure::text as objeto
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('authenticated', p.oid, 'execute'))
union all
select case when c.relkind in ('r', 'p') and not c.relrowsecurity then 'tabla_sin_rls'
            else 'tabla_o_vista_legible' end,
       c.relname::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
  and (has_table_privilege('anon', c.oid, 'select')
       or has_table_privilege('authenticated', c.oid, 'select')
       or (c.relkind in ('r', 'p') and not c.relrowsecurity));
