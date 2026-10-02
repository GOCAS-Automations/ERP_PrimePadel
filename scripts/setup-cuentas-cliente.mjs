// Crea (o actualiza) las cuentas del cliente Prime Padel.
// Pre-requisito: haber ejecutado supabase/migrations/001_tres_roles.sql en Supabase.
//
// Uso:
//   PP_PASS_CESARC=... PP_PASS_MAESTRO=... PP_PASS_ADMIN=... PP_PASS_RECEPCION1=... PP_PASS_RECEPCION2=... \n//     node scripts/setup-cuentas-cliente.mjs
//   (las contraseñas NUNCA van en el repo; se pasan por variables de entorno)
//
// Crea/actualiza:
//   - recepcion1     (rol: recepcion)
//   - recepcion2     (rol: recepcion)
//   - admin           (rol: admin)
//
// El usuario maestro (tú) ya existe; la migración SQL lo movió a rol maestro.

import { getAdminClient } from "./lib/supabase.mjs";

const INTERNAL_DOMAIN = "primepadel.local";

const CUENTAS = [
  {
    username: "CesarC",
    nombre: "Cesar Emilio Castaño Marin",
    rol: "maestro",
    password: null, // se lee de PP_PASS_<USERNAME>
  },
  {
    username: "maestro",
    nombre: "Cuenta Maestra Prime Padel",
    rol: "maestro",
    password: null, // se lee de PP_PASS_<USERNAME>
  },
  {
    username: "admin",
    nombre: "Administrador del club",
    rol: "admin",
    password: null, // se lee de PP_PASS_<USERNAME>
  },
  {
    username: "recepcion1",
    nombre: "Recepción 1 (turno mañana)",
    rol: "recepcion",
    password: null, // se lee de PP_PASS_<USERNAME>
  },
  {
    username: "recepcion2",
    nombre: "Recepción 2 (turno tarde)",
    rol: "recepcion",
    password: null, // se lee de PP_PASS_<USERNAME>
  },
];

function usernameToEmail(u) {
  return `${u.toLowerCase()}@${INTERNAL_DOMAIN}`;
}

async function ensureCuenta(sb, cuenta) {
  const email = usernameToEmail(cuenta.username);

  // Buscar si ya existe en auth.users
  const { data: list, error: eList } = await sb.auth.admin.listUsers({ perPage: 500 });
  if (eList) throw eList;
  const existing = list?.users?.find((u) => u.email?.toLowerCase() === email);

  let userId;
  if (existing) {
    console.log(`  · ${cuenta.username} ya existe — actualizando contraseña y metadata...`);
    const { error } = await sb.auth.admin.updateUserById(existing.id, {
      password: cuenta.password,
      email_confirm: true,
      user_metadata: { nombre: cuenta.nombre },
    });
    if (error) throw error;
    userId = existing.id;
  } else {
    console.log(`  · creando ${cuenta.username}...`);
    const { data: created, error } = await sb.auth.admin.createUser({
      email,
      password: cuenta.password,
      email_confirm: true,
      user_metadata: { nombre: cuenta.nombre },
    });
    if (error) throw error;
    userId = created.user.id;
  }

  // Upsert perfil
  const { error: ePerfil } = await sb.from("perfiles").upsert({
    user_id: userId,
    nombre: cuenta.nombre,
    rol: cuenta.rol,
    activo: true,
  });
  if (ePerfil) throw ePerfil;
}

async function run() {
  for (const c of CUENTAS) {
    const pass = process.env[`PP_PASS_${c.username.toUpperCase()}`];
    if (!pass || pass.length < 12) {
      throw new Error(`Falta PP_PASS_${c.username.toUpperCase()} (mínimo 12 caracteres)`);
    }
    c.password = pass;
  }

  const sb = getAdminClient();
  console.log("Configurando cuentas del cliente Prime Padel...\n");

  for (const cuenta of CUENTAS) {
    await ensureCuenta(sb, cuenta);
  }

  console.log("\n============================================================");
  console.log("✅ Cuentas listas:");
  console.log("============================================================");
  for (const c of CUENTAS) {
    console.log(`   Usuario:    ${c.username.padEnd(12)}  Rol: ${c.rol.padEnd(10)}  Password: (la que pasaste por entorno)`);
  }
  console.log("============================================================");
  console.log("\nEl login en /login se hace con el USUARIO (sin @), no con email.");
  console.log("Comparte estas credenciales con el cliente y pídele que las cambie tras el primer ingreso.\n");
}

run().catch((e) => {
  console.error("\n❌ Error:", e.message ?? e);
  process.exit(1);
});
