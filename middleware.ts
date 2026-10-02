import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

const PUBLIC_PATHS = ["/login"];

function isPublic(path: string) {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookies: { name: string; value: string; options: CookieOptions }[]) {
          cookies.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);
            response.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const tieneError = request.nextUrl.searchParams.has("error");

  if (!user && !isPublic(path)) {
    const url = new URL("/login", request.url);
    if (path !== "/") url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  // Si la sesión existe pero el usuario fue redirigido a /login con error
  // (perfil borrado, desactivado, etc.), no lo bouncees de vuelta — dejalo
  // ver el mensaje y volver a loguearse, lo cual reemplaza la sesión vieja.
  if (user && path === "/login" && !tieneError) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    // api/heartbeat queda fuera: lo invoca el cron de Vercel (sin sesión) y se
    // protege solo con CRON_SECRET dentro del route handler.
    "/((?!_next/static|_next/image|api/heartbeat|favicon.ico|logo.png|logo-alt.png|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico)$).*)",
  ],
};
