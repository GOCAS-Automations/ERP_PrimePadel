# Prime Padel — ERP de Inventario

Mini-ERP web para el control de inventario, compras, ventas y traslados del club **Prime Padel** (Cali, Colombia).

> Documentación técnica viva del sistema. El manual de usuario final (no técnico) está en [`docs/manual-usuario.html`](docs/manual-usuario.html) y la guía extendida del rol Maestro en [`docs/manual-maestro.html`](docs/manual-maestro.html) (se mantienen como HTML, listos para abrir en el navegador o imprimir a PDF).

---

## Tabla de contenido

1. [Resumen del producto](#resumen-del-producto)
2. [Estado actual](#estado-actual)
3. [Stack tecnológico](#stack-tecnológico)
4. [Arquitectura](#arquitectura)
5. [Modelo de datos](#modelo-de-datos)
6. [Módulos funcionales](#módulos-funcionales)
7. [Paleta visual y marca](#paleta-visual-y-marca)
8. [Puesta en marcha local](#puesta-en-marcha-local)
9. [Variables de entorno](#variables-de-entorno)
10. [Despliegue](#despliegue)
11. [Roles y permisos](#roles-y-permisos)
12. [Seguridad](#seguridad)
13. [Carga masiva por CSV](#carga-masiva-por-csv)
14. [Descarga de transacciones a CSV](#descarga-de-transacciones-a-csv)
15. [Tarifas y precios diferenciados](#tarifas-y-precios-diferenciados)
16. [Migraciones SQL](#migraciones-sql)

---

## Resumen del producto

Prime Padel es un club con 5 canchas de pádel, 2 de vóley playa, barbería, sala VIP, tienda de bebidas/aperitivos y restaurantes concesionados. Maneja inventario de bebidas alcohólicas y no alcohólicas, mecato, bolas de pádel y artículos deportivos, distribuido en varias ubicaciones físicas (bodegas, nevera, barra, vitrina).

El ERP permite:

- Visualizar y administrar el inventario total y por ubicación.
- Registrar **ventas, compras y traslados** entre ubicaciones, con descuento/aumento atómico de stock.
- Cargar transacciones masivamente por CSV y descargar reportes por rango de fechas.
- Calcular margen real de ventas (costo y precio se almacenan por separado al momento de la transacción).
- Analizar tendencias con un dashboard de KPIs, gráficas, top productos y alertas de stock bajo.
- Separar accesos en tres niveles de rol con jerarquía.

## Estado actual

**Fase:** Versión completa — entregada al cliente.
**Fecha de entrega:** 2026-04-25.
**URL producción:** https://erp-prime-padel.vercel.app/

Funcionalidades operativas:

- [x] Auth con login por usuario (no email) y middleware de rutas.
- [x] Tres roles con jerarquía: **maestro / admin / recepción**.
- [x] Gestión de usuarios desde `/usuarios` (crear, editar, reset password, desactivar, cambiar rol).
- [x] Permisos por rol validados en cada server action (no solo en UI).
- [x] Inventario: CRUD productos/servicios, filtros multi-select + paginación, ficha de detalle con stock por ubicación, histórico mensual, ajustes auditados.
- [x] Ajuste de inventario con detección de diferencias y registro en `ajustes_inventario`.
- [x] Transacciones: ventas, compras y traslados con multi-item, validación de stock, reversa automática al eliminar/editar.
- [x] **Costo y precio separados por ítem** — snapshot histórico, permite calcular margen real de ventas.
- [x] Edición de transacciones con rollback automático si la nueva versión falla.
- [x] Carga masiva de transacciones por CSV (DD/MM/AAAA, preview, validación, agrupación por ticket).
- [x] **Descarga de transacciones a CSV** por rango de fechas, dos modos (resumen por ítem con margen / historial por transacción).
- [x] Dashboard con pestañas Ventas / Inventario / Alertas, KPIs, filtros por categoría/mes/rango de fechas, ventas última semana, top productos, gráfica apilada por día de la semana, alertas detalladas con desglose por ubicación, días estimados de stock (predictivo, en tab Inventario).
- [x] Listas de precios: CRUD para gestionar canales y profesores externos.
- [x] Categorías y ubicaciones con CRUD y soft-delete cuando hay datos asociados.
- [x] Responsive con hamburger menu en móvil.
- [x] **RLS habilitado** en todas las tablas del dominio (acceso solo vía server con service_role).
- [x] 145 productos migrados desde Alegra + 8 meses de histórico de ventas.
- [x] 5 cuentas creadas: 2 maestros (CesarC, maestro), 1 admin, 2 recepción.

## Stack tecnológico

| Capa | Tecnología |
|------|-----------|
| Framework | Next.js 15 (App Router) + TypeScript |
| UI | Tailwind CSS + shadcn/ui |
| Gráficas | Recharts |
| Tablas | TanStack Table |
| Validación | Zod |
| CSV | Papa Parse |
| BD / Auth | Supabase (Postgres + Auth) |
| Hosting | Vercel |

## Arquitectura

- **Server Components** por defecto; cliente solo donde haya interactividad.
- Escrituras a BD a través de **Server Actions** o **Route Handlers**; nunca desde el navegador con claves.
- Lógica transaccional (ej. registrar venta + descontar stock) en **funciones RPC de Postgres** para garantizar atomicidad.
- **Row Level Security (RLS)** habilitado: el cliente no puede consultar BD directamente con la `publishable_key`. Todo pasa por server con `service_role_key`.

```
Navegador  ─►  Next.js (Vercel)  ─►  Supabase Postgres
                   │
                   └── Server Actions / Route Handlers (con service_role_key)
```

## Modelo de datos

Schema completo en [`supabase/schema.sql`](supabase/schema.sql). Resumen:

- `categorias`, `impuestos`, `listas_precios`, `ubicaciones` — catálogos maestros.
- `productos` — catálogo de productos y servicios. Distinción `tipo` (producto/servicio) y `es_inventariable`.
- `precios_producto` — N–N entre productos y tarifas (`listas_precios`). Un producto puede tener un precio manual para una tarifa específica. Si no lo tiene, el sistema usa `precio_detal × (1 − descuento_porcentaje/100)` de esa tarifa.
- `stock_por_ubicacion` — cantidad por (producto, ubicación). PK compuesta. **Fuente de verdad** del inventario.
- `transacciones` — compra | venta | traslado. Header con tipo, fecha, total, usuario, notas, origen.
- `transaccion_items` — líneas de cada transacción. Incluye `precio_unitario` Y `costo_unitario` (snapshot histórico al momento de la transacción).
- `ajustes_inventario` — auditoría de ajustes manuales (conteo físico, mermas, roturas, correcciones).
- `ventas_historicas_mensuales` — agregados mensuales importados desde Alegra (sep 2025 – abr 2026).
- `perfiles` — vinculado a `auth.users`. Rol: `maestro | admin | recepcion`.

### Funciones RPC (atómicas)
- `registrar_transaccion(p_tipo, p_fecha, p_usuario, p_notas, p_origen, p_items jsonb)` — crea transacción + items, ajusta stock según tipo, bloquea si stock insuficiente.
- `registrar_ajuste_inventario(p_producto, p_ubicacion, p_cantidad_nueva, p_motivo, p_notas, p_usuario)` — setea stock absoluto y deja auditoría.

## Módulos funcionales

### Inventario
- Tabla paginada con búsqueda y filtros **multi-select** por categoría, ubicación, producto; filtro por rango de cantidad.
- CRUD productos/servicios con confirmación.
- Ficha de detalle con stock por ubicación, histórico mensual y botón de ajuste.

### Transacciones
- Registro individual de ventas, compras y traslados desde formulario con multi-item.
- En **ventas** se piden Costo y Precio por separado (margen calculable). En compra/traslado se pide solo costo.
- Carga masiva por **CSV** con preview + validación antes de confirmar.
- Editar y eliminar transacciones según rol (recepción solo sus propias del día).
- Descarga CSV por rango de fechas en dos modos.
- Filtros multi-select por categoría, producto, rango de fechas, tipo.

### Dashboard (solo Maestro)
Tres pestañas: Ventas / Inventario / Alertas. Filtros del tab Ventas: categoría (multi), Mes (atajo) o Fecha desde / hasta (excluyentes).

- **Ventas:** ventas última semana (transacciones reales), consumo por mes, top productos, por categoría, por día de la semana. Las gráficas mensuales (consumo por mes, top productos, por categoría, cantidades vendidas) **combinan** el histórico migrado de Alegra con las ventas registradas en este sistema, así la tendencia no se corta al terminar Alegra.
- **Inventario:** stock por ubicación, SKUs por categoría, **días estimados de stock** (predictivo, usa el histórico combinado Alegra + sistema para tener un promedio estable). Ver también la **vista detallada de cada ubicación** en `/ubicaciones/<id>` que lista los productos presentes y sus cantidades.
- **Utilidades:** gráfica de costos vs ingresos por producto/servicio, utilidad bruta total y margen %, tabla paginada con margen por producto.
- **Alertas:** productos por acabarse en nevera, en bodegas, sin movimiento.
- **KPIs (siempre visibles):** productos activos, ubicaciones, stock total, valor del inventario, alertas activas.

### Usuarios (solo Maestro)
CRUD, reset de password, cambio de rol, desactivación. Nombres de usuario internos (no email) traducidos a emails sintéticos en `@primepadel.local`.

## Paleta visual y marca

| Uso | Color | Hex |
|-----|-------|-----|
| Fondo / texto principal | Negro | `#0A0A0A` |
| Superficie | Blanco | `#FFFFFF` |
| Gris logo | Gris claro | `#E5E5E5` |
| Acento logo | Amarillo Prime | `#F5C518` |
| Acento secundario | Naranja pastel | `#FFB366` |
| CTA / hover | Naranja vivo | `#FF8C42` |

Logo en `public/logo.png`. Fuente: Inter / Geist.

## Puesta en marcha local

```bash
pnpm install
cp .env.example .env.local   # llenar con credenciales
pnpm dev
```

Requisitos: Node 20+, pnpm 9+, proyecto de Supabase creado.

## Variables de entorno

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...   # solo server-side; nunca commit
CRON_SECRET=...                 # cadena aleatoria larga; protege /api/heartbeat (Vercel la envía como Bearer)
```

## Despliegue

1. Push a rama `main`.
2. Vercel auto-despliega.
3. Variables de entorno configuradas en Vercel Dashboard (incluidas `SUPABASE_SERVICE_ROLE_KEY` y `CRON_SECRET`).

### Latido de Supabase (anti-pausa del plan gratis)

Supabase pausa los proyectos gratis tras 7 días sin actividad. [`vercel.json`](vercel.json) define un cron diario (12:00 UTC) que llama a `/api/heartbeat` ([`app/api/heartbeat/route.ts`](app/api/heartbeat/route.ts)); el endpoint exige `Authorization: Bearer $CRON_SECRET` y hace una consulta real a Postgres. Verificar en Vercel → proyecto → Settings → Cron Jobs que aparece y que la última ejecución devolvió 200.

## Roles y permisos

Jerarquía: `recepcion (1) < admin (2) < maestro (3)`. Definida en [`lib/auth.ts`](lib/auth.ts).

| Acción | Maestro | Admin | Recepción |
|--------|:-------:|:-----:|:---------:|
| Registrar venta / traslado | ✅ | ✅ | ✅ |
| Registrar compra | ✅ | ✅ | ❌ |
| Editar / eliminar transacciones | ✅ todo | ✅ excepto del Maestro | ✅ solo las suyas del día |
| Carga masiva CSV | ✅ | ✅ | ✅ (solo ventas/traslados) |
| Descarga CSV de transacciones | ✅ | ✅ | ❌ |
| Ver inventario | ✅ | ✅ | ❌ |
| CRUD productos | ✅ | ✅ | ❌ |
| Editar costos y precios | ✅ | ❌ | ❌ |
| Eliminar productos | ✅ | ❌ | ❌ |
| Ajuste de inventario | ✅ | ✅ | ❌ |
| CRUD ubicaciones (incl. vista detallada) | ✅ | ✅ | ❌ |
| CRUD categorías / tarifas | ✅ | ❌ | ❌ |
| Ver Dashboard | ✅ | ❌ | ❌ |
| Gestionar usuarios | ✅ | ❌ | ❌ |

La validación de rol se hace SIEMPRE en server actions (`requireProfile`, `requireAdmin`, `requireMaestro`), no solo escondiendo botones en la UI.

## Seguridad

- **RLS activo** en todas las tablas del dominio (ver [`supabase/rls.sql`](supabase/rls.sql)). Sin políticas → la API REST con la `publishable_key` devuelve 0 filas. El cliente no puede consultar BD directamente.
- **`service_role_key`** solo en variables de entorno server-side. El único módulo que la usa (`lib/supabase/admin-server.ts`) tiene `import "server-only"` para que el bundler de Next.js falle si alguien intenta importarla desde un componente cliente.
- **RBAC** validado en backend por cada operación sensible (delete, edit, export, gestión de usuarios).
- **Endurecimiento de BD**: [`supabase/security_hardening.sql`](supabase/security_hardening.sql) (idempotente) revoca a `anon`/`authenticated` todo acceso a tablas, vistas y funciones RPC del esquema `public`, y pone las vistas en `security_invoker`. Re-ejecutarlo tras cualquier migración que recree funciones o vistas.
- **Cabeceras web**: CSP, HSTS, `X-Frame-Options`, `Referrer-Policy` y `Permissions-Policy` en [`next.config.mjs`](next.config.mjs); páginas autenticadas con `Cache-Control: private, no-store`.
- **Login**: parámetro `next` validado (sin open redirect) y límite de intentos fallidos por usuario/IP (en memoria por instancia: mitigación parcial).
- **Cuentas**: las contraseñas nunca van en el repo; `scripts/setup-cuentas-cliente.mjs` las lee de variables de entorno `PP_PASS_<USUARIO>`. Desactivar "Allow new users to sign up" en Supabase Auth (los usuarios se crean desde `/usuarios`).
- **Backups**: el plan gratis de Supabase **no** incluye backups automáticos; hacer un respaldo manual periódico (`pg_dump` o exportar las tablas a CSV desde el Table Editor).

## Carga masiva por CSV

Flujo: descargar plantilla → llenar cantidades → subir → parsear con Papa Parse → validar con Zod → mostrar preview con errores resaltados → el usuario confirma → inserción transaccional en BD vía RPC `registrar_transaccion`.

La **plantilla** se genera dinámicamente en el server con una fila por (producto × tipo de transacción) permitido para el rol:
- **Recepción**: una fila de venta y una de traslado por cada producto inventariable, una fila de venta por cada servicio.
- **Admin/Maestro**: además añade una fila de compra por cada producto inventariable.

El usuario solo modifica las **cantidades** de los productos que efectivamente se movieron. Las filas con cantidad 0 (las que dejó sin tocar) se ignoran al importar.

Formato (la plantilla descargada trae solo encabezados + filas de productos, sin comentarios):

```csv
fecha,tipo,codigo_producto,nombre_producto,ubicacion,ubicacion_destino,cantidad,valor_unitario,notas,ticket
20/04/2026,venta,CERV-001,Cerveza Corona,Barra,,2,8000,,T-001
20/04/2026,compra,CERV-001,Cerveza Corona,Bodega Principal,,24,5500,Pedido proveedor,
20/04/2026,traslado,CERV-001,Cerveza Corona,Bodega Principal,Nevera Barra,12,5500,,
```

- `fecha`: `DD/MM/AAAA` o `AAAA-MM-DD`.
- `tipo`: `venta`, `compra` o `traslado`.
- `nombre_producto`: solo referencia visual; el mapeo se hace por `codigo_producto`. Se ignora al importar.
- `valor_unitario`: en venta = precio al cliente; en compra/traslado = costo unitario. (El parser acepta `precio_unitario` como alias por compatibilidad.)
- `ubicacion`: origen para venta/traslado, destino para compra.
- `ubicacion_destino`: solo aplica en traslado.
- `cantidad = 0` o vacía → fila ignorada.
- `costo_unitario` se backfillea automáticamente: en compras coincide con `valor_unitario`; en traslados queda en 0 (los traslados no manejan valor); en ventas se usa el **costo promedio ponderado de compras** del producto al momento de la importación (no el costo del catálogo).
- **Importación parcial**: si hay filas con error, las filas válidas se importan igual y las inválidas se reportan en el resumen (no bloquean a las buenas).

## Descarga de transacciones a CSV

Botón en `/transacciones` (solo admin/maestro). Dos modos:

- **Resumen por ítem** — agregado por (producto, tipo). Máx 2 filas por producto: una `venta` (consumo) y una `compra`. Trae cantidad total, valor total, costo total, **margen total y porcentual** (solo en ventas), precio promedio, número de transacciones y rango de fechas. Los traslados se excluyen.
- **Historial por transacción** — una fila por transacción, incluyendo traslados. Útil para listado completo de operaciones.

Validaciones: rango ≤ 1 año, fechas válidas, fecha inicial ≤ final. Salida en UTF-8 con BOM (Excel en Windows abre acentos correctamente). En el modo "Resumen por ítem", si una venta antigua quedó con `costo_unitario = 0` en BD, el reporte cae al costo promedio actual del producto para que el margen no salga sesgado.

## Tarifas y precios diferenciados

Cada tarifa (registro en `listas_precios`, ruta `/tarifas`) tiene un `descuento_porcentaje` (0-100). El sistema calcula el precio de cualquier producto en una tarifa como:

```
precio = override_manual ?? precio_detal × (1 − descuento_porcentaje / 100)
```

Donde `override_manual` es el precio en `precios_producto` para esa (producto, tarifa) si existe.

Ejemplo: tarifa "Staff Prime Padel" con `descuento_porcentaje = 20`. Para un producto cuyo precio Detal es $10.000:
- Si no hay precio configurado para `STAFF_PRIME` en `precios_producto` → precio automático = $8.000.
- Si configuras un override de $7.500 → ese precio anula el cálculo automático.

La tarifa marcada como `es_default` (Detal) siempre tiene `descuento_porcentaje = 0` y se usa como precio base.

En la UI de productos (`/inventario/<id>` → editar), se muestra para cada tarifa el precio efectivo y un indicador del origen (Manual / Auto / Precio base).

## Migraciones SQL

Los cambios de schema viven en archivos numerados/descriptivos en [`supabase/`](supabase/) y se ejecutan **manualmente** en el SQL Editor de Supabase (en orden):

1. `schema.sql` — instalación inicial completa. **Recrea** todas las tablas (DROP CASCADE), úsalo solo en setup desde cero.
2. `rls.sql` — habilita RLS en todas las tablas del dominio. Idempotente.
3. `migration-costo-unitario.sql` — añade columna `costo_unitario` a `transaccion_items` con backfill + recrea el RPC para aceptarla. Idempotente.
4. `migration-tarifas-descuento.sql` — añade columna `descuento_porcentaje` a `listas_precios` (por defecto 0). Idempotente.
5. `security_hardening.sql` — revoca acceso de `anon`/`authenticated` a tablas, vistas y RPC; vistas en `security_invoker`. Idempotente; **ejecutar siempre al final** y re-ejecutar tras recrear funciones/vistas.

Para futuras migraciones: crear un nuevo archivo `migration-<descripcion>.sql` en `supabase/`, idempotente (con `IF NOT EXISTS` o `IF EXISTS`), y mantener `schema.sql` actualizado para reflejar el modelo final.

### Limpieza para entrega

- `reset-operacion.sql` — **destructivo**. Borra todas las transacciones, ajustes y stock acumulado durante el desarrollo/pruebas, dejando el sistema en cero pero **conservando el catálogo** (productos, categorías, ubicaciones, tarifas, precios, usuarios). El histórico de Alegra (`ventas_historicas_mensuales`) se conserva por defecto; hay una línea opcional comentada para borrarlo también. Correr una sola vez justo antes de entregar al cliente, idealmente con un respaldo previo.
