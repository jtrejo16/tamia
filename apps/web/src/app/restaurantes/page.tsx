import { PLANS, TRIAL_DAYS } from "@empleado/shared/plans";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Bubble, Check, Feature, IconBell, IconCalendar, IconChat, IconPhone, IconShield, IconUser, Pain, SectionTitle } from "@/components/landing-parts";
import { getValidSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const TITLE = "Jovia para restaurantes · Pedidos y reservaciones por WhatsApp, las 24 horas";
const DESCRIPTION =
  "Jovia contesta por WhatsApp a los clientes de tu taquería, pizzería o restaurante: les dice el menú y los precios, toma pedidos para recoger o a domicilio y reserva mesas. Tú los ves en un tablero. Pruébalo 14 días gratis.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  robots: { index: true, follow: true },
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website", locale: "es_MX", siteName: "Jovia" },
  metadataBase: new URL(process.env.PUBLIC_BASE_URL?.trim() || "https://www.jovia.mx"),
  alternates: { canonical: "/restaurantes" },
};

const basic = PLANS.esencial;

/** Portada para restaurantes (www.jovia.mx/restaurantes). Con sesion va directo al panel. */
export default async function RestaurantsLanding() {
  if (await getValidSession()) redirect("/bandeja");

  const signup = (giro: string) => `/registro?giro=${giro}`;

  return (
    <div className="min-h-full bg-white text-slate-900">
      <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <a href="/" className="flex items-center gap-2.5" aria-label="Jovia, inicio">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-700 text-lg font-bold text-white">J</span>
            <span className="text-lg font-semibold tracking-tight">Jovia</span>
            <span className="hidden rounded-full bg-teal-100 px-2 py-0.5 text-xs font-semibold text-teal-900 sm:inline">Restaurantes</span>
          </a>
          <nav aria-label="Secciones" className="hidden items-center gap-7 text-sm font-medium text-slate-600 md:flex">
            <a className="hover:text-teal-800" href="#que-hace">Qué hace</a>
            <a className="hover:text-teal-800" href="#como-se-ve">Cómo se ve</a>
            <a className="hover:text-teal-800" href="#giros">Tu giro</a>
            <a className="hover:text-teal-800" href="#precio">Precio</a>
            <a className="hover:text-teal-800" href="#preguntas">Preguntas</a>
          </nav>
          <div className="flex items-center gap-2 sm:gap-3">
            <a href="/login" className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">Iniciar sesión</a>
            <a href={signup("restaurante")} className="rounded-lg bg-teal-700 px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-teal-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2">
              Probar gratis
            </a>
          </div>
        </div>
      </header>

      <main>
        {/* ------------------------------------------------------------ héroe */}
        <section className="relative overflow-hidden bg-gradient-to-b from-teal-50 via-white to-white">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-12 sm:px-6 md:pt-20 lg:grid-cols-[1.05fr_0.95fr] lg:pb-24">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full bg-teal-100/70 px-3 py-1 text-xs font-semibold text-teal-900">
                <span className="h-1.5 w-1.5 rounded-full bg-teal-600" /> Para taquerías, pizzerías y restaurantes
              </p>
              <h1 className="mt-5 text-4xl font-semibold leading-[1.1] tracking-tight text-slate-900 sm:text-5xl">
                Que ningún pedido se pierda <span className="text-teal-700">en la hora pico</span>
              </h1>
              <p className="mt-5 max-w-xl text-lg leading-relaxed text-slate-600">
                Jovia contesta por WhatsApp, dice tu menú y tus precios, <strong className="font-semibold text-slate-800">toma pedidos</strong> para recoger o a domicilio y <strong className="font-semibold text-slate-800">reserva mesas</strong>. Tú ves todo en un tablero y tu equipo solo cocina.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                <a href={signup("restaurante")} className="inline-flex items-center justify-center rounded-xl bg-teal-700 px-6 py-3.5 text-base font-semibold text-white shadow-sm hover:bg-teal-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2">
                  Prueba {TRIAL_DAYS} días gratis
                </a>
                <a href="#como-se-ve" className="inline-flex items-center justify-center rounded-xl px-5 py-3.5 text-base font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50">
                  Ver cómo se ve
                </a>
              </div>
              <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600">
                {["Sin tarjeta para empezar", "Ya trae un menú de ejemplo", "Cancelas cuando quieras"].map((t) => (
                  <li key={t} className="flex items-center gap-1.5"><Check /> {t}</li>
                ))}
              </ul>
            </div>

            <div className="relative mx-auto w-full max-w-md" aria-label="Ejemplo de un pedido por WhatsApp con Jovia">
              <div className="absolute -inset-4 -z-10 rounded-[2rem] bg-gradient-to-br from-teal-200/50 to-emerald-100/40 blur-2xl" />
              <div className="overflow-hidden rounded-3xl bg-white shadow-xl ring-1 ring-slate-200">
                <div className="flex items-center gap-3 bg-teal-700 px-4 py-3 text-white">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-sm font-semibold">T</span>
                  <div className="leading-tight">
                    <p className="text-sm font-semibold">Taquería Don Pepe</p>
                    <p className="text-xs text-teal-100">asistente virtual · en línea</p>
                  </div>
                </div>
                <div className="space-y-2.5 bg-[#efeae2] p-4 text-[13.5px] leading-snug">
                  <Bubble who="in">Hola, quiero 3 de pastor y una horchata grande, para recoger</Bubble>
                  <Bubble who="out">¡Hola! Te confirmo: <b>3 tacos al pastor</b> ($66) y <b>1 agua de horchata grande</b> ($37). Total <b>$103</b>, pagas al recoger. ¿Me das tu nombre?</Bubble>
                  <Bubble who="in">Laura</Bubble>
                  <Bubble who="out">Gracias, Laura. ¿Te lo confirmo así? Estará listo en unos 20 minutos.</Bubble>
                  <Bubble who="in">Sí</Bubble>
                  <Bubble who="out">¡Listo! Tu <b>pedido #12</b> quedó. Te aviso cuando esté listo para recoger. ✅</Bubble>
                </div>
              </div>
              <p className="mt-3 text-center text-xs text-slate-500">Ejemplo ilustrativo de una conversación.</p>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ problema */}
        <section className="border-y border-slate-200 bg-slate-50">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 className="mx-auto max-w-2xl text-center text-2xl font-semibold tracking-tight sm:text-3xl">
              En la hora pico, el teléfono suena y el WhatsApp se llena
            </h2>
            <div className="mt-10 grid gap-5 sm:grid-cols-3">
              <Pain title="Mensajes que nadie alcanza a contestar" text="Mientras se cocina no se puede escribir. El cliente que no recibe respuesta pide en otro lado." />
              <Pain title="Pedidos mal anotados" text="Un «sin cebolla» que se pierde, una dirección incompleta o un total mal sumado terminan en un pedido equivocado." />
              <Pain title="Siempre las mismas preguntas" text="¿Qué tienen?, ¿cuánto cuesta?, ¿hasta qué hora abren?, ¿mandan a mi colonia? Cada una le quita tiempo a tu equipo." />
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ qué hace */}
        <section id="que-hace" className="scroll-mt-20 mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
          <SectionTitle kicker="Qué hace" title="Atiende al cliente de principio a fin, y a ti solo te avisa lo importante" />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <Feature icon={<IconChat />} title="Contesta con tu menú real" text="Platillos, precios, ingredientes y extras salen de tu menú. Lo que se acabó lo marcas como agotado en un clic y deja de ofrecerlo. No inventa platillos ni promociones." />
            <Feature icon={<IconBell />} title="Toma pedidos para recoger" text="Entiende «tres de pastor sin cebolla», pregunta lo que falta (tamaño, tortilla…), repite el pedido con el total y lo crea solo cuando el cliente confirma. El total lo calcula el sistema, no la IA." />
            <Feature icon={<IconUser />} title="Pedidos a domicilio por zonas" text="Tú defines las colonias que cubres y el costo de envío de cada una, con pedido mínimo y envío gratis desde cierto monto. Si el cliente es de otra zona, se lo dice y le ofrece pasar a recoger." />
            <Feature icon={<IconCalendar />} title="Reserva mesas por aforo" text="Tú dices cuántas personas caben a la vez y cuánto dura una mesa. Solo ofrece horas con lugar real, respeta tu horario y no se pasa del aforo." />
            <Feature icon={<IconPhone />} title="Contesta el teléfono" tag="Complemento" text="Una voz con acento mexicano atiende llamadas, dice el menú y puede tomar pedidos y reservaciones, con la misma confirmación que por WhatsApp. Se contrata aparte; pregúntanos." />
            <Feature icon={<IconShield />} title="Sabe cuándo pasarte al cliente" text="Alergias, quejas, reembolsos, eventos o pedidos muy grandes: no improvisa, te avisa y te deja un resumen. Puedes empezar en modo «copiloto» y aprobar cada respuesta." />
          </div>
        </section>

        {/* ------------------------------------------------------------ cómo se ve */}
        <section id="como-se-ve" className="scroll-mt-20 bg-slate-50">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
            <SectionTitle kicker="Cómo se ve" title="Tus pedidos y reservaciones, en un tablero que se actualiza solo" />
            <p className="mx-auto mt-3 max-w-2xl text-center text-slate-600">
              Cada pedido llega con su cliente, lo que pidió, las notas de cada platillo y el total. Avanzas su estado con un botón y al cliente le llega el aviso. Si prefieres, también te llega un correo por cada pedido nuevo.
            </p>
            <div className="mt-10 grid gap-4 md:grid-cols-3" aria-label="Ejemplo ilustrativo del tablero de pedidos">
              {[
                ["Nuevos", "bg-amber-50 ring-amber-300", [["#12 · Laura", "3 × Taco al pastor (harina)", "Sin cebolla · $103 · Recoger"], ["#13 · Carlos", "1 × Alambre de res", "A domicilio · col. Centro · $140"]]],
                ["Preparando", "bg-sky-50 ring-sky-300", [["#11 · Ana", "5 × Taco de suadero", "$130 · Recoger"]]],
                ["Listos", "bg-green-50 ring-green-300", [["#10 · Luis", "2 × Gringa de pastor", "$110 · Recoger"]]],
              ].map(([title, tone, cards]) => (
                <div key={title as string} className={`space-y-3 rounded-2xl p-3 ring-1 ${tone as string}`}>
                  <p className="text-sm font-semibold text-slate-800">{title as string}</p>
                  {(cards as string[][]).map(([who, what, meta]) => (
                    <div key={who} className="space-y-1 rounded-xl bg-white p-3 text-sm shadow-sm ring-1 ring-slate-200">
                      <p className="font-semibold text-slate-900">{who}</p>
                      <p className="text-slate-700">{what}</p>
                      <p className="text-xs text-slate-500">{meta}</p>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <p className="mt-4 text-center text-xs text-slate-500">Ilustración del tablero. Los datos son de ejemplo.</p>
            <div className="mx-auto mt-10 grid max-w-4xl gap-4 sm:grid-cols-3">
              {[
                ["Agenda del día", "Las reservaciones de hoy, los comensales y qué tan lleno va el restaurante contra tu aforo."],
                ["Avisos al cliente", "Cuando su pedido está listo o va en camino, o si cancelas algo, le llega el mensaje."],
                ["Primeros pasos", "Una lista con tu avance te dice qué falta para quedar listo: menú, horario, WhatsApp y avisos."],
              ].map(([t, d]) => (
                <div key={t} className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
                  <p className="font-semibold text-slate-900">{t}</p>
                  <p className="mt-1 text-sm leading-relaxed text-slate-600">{d}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ giros */}
        <section id="giros" className="scroll-mt-20 mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
          <SectionTitle kicker="Elige tu giro" title="Arranca con un menú de ejemplo y cámbialo por el tuyo" />
          <p className="mx-auto mt-3 max-w-2xl text-center text-slate-600">
            Al registrarte tu negocio ya trae un menú de ejemplo con modificadores (tortilla, tamaño, extras…). Solo cambias platillos y precios, o importas el tuyo desde una hoja de Excel.
          </p>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {[
              ["taqueria", "Taquerías", "Tacos por pieza con tortilla y extras, órdenes, especialidades y bebidas con tamaño."],
              ["pizzeria", "Pizzerías", "Pizzas con tamaño obligatorio, orilla y extras, complementos, bebidas y postres."],
              ["restaurante", "Restaurantes, fondas y cafeterías", "Entradas, platos fuertes con guarnición, bebidas y postres."],
            ].map(([id, name, text]) => (
              <div key={id} className="flex flex-col rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <h3 className="text-lg font-semibold text-slate-900">{name}</h3>
                <p className="mt-2 flex-1 text-[15px] leading-relaxed text-slate-600">{text}</p>
                <a href={signup(id as string)} className="mt-5 inline-flex justify-center rounded-xl px-5 py-3 text-sm font-semibold text-teal-800 ring-1 ring-teal-700/40 hover:bg-teal-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2">
                  Probar como {(name as string).split(",")[0]!.replace(/s$/, "").toLowerCase()}
                </a>
              </div>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------------------ cómo empezar */}
        <section className="border-y border-slate-200 bg-slate-50">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
            <SectionTitle kicker="Cómo empezar" title="Del registro a tus primeros pedidos, en tres pasos" />
            <ol className="mt-12 grid gap-6 md:grid-cols-3">
              {[
                ["1", "Crea tu cuenta", `Elige tu giro y registra tu negocio en un minuto. Tienes ${TRIAL_DAYS} días de prueba sin tarjeta. Revisamos cada cuenta nueva y la activamos, normalmente el mismo día hábil.`],
                ["2", "Ajusta tu menú", "Cambia el menú de ejemplo por el tuyo (o importa una hoja de Excel), define tu horario, tus zonas de entrega y si quieres reservaciones."],
                ["3", "Conecta tu WhatsApp", "Conectas el número de WhatsApp Business de tu negocio. Empieza en «copiloto» (tú apruebas) y pasa a automático cuando confíes."],
              ].map(([n, t, d]) => (
                <li key={n} className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-teal-700 text-base font-semibold text-white">{n}</span>
                  <h3 className="mt-4 text-lg font-semibold">{t}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-slate-600">{d}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ------------------------------------------------------------ honestidad */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
          <div className="grid items-start gap-10 lg:grid-cols-2">
            <div>
              <SectionTitle kicker="Con transparencia" title="Lo que Jovia es, y lo que todavía no es" align="left" />
              <p className="mt-5 text-[15px] leading-relaxed text-slate-600">
                Jovia es tu recepción por WhatsApp: toma el pedido y la reservación y se los pasa a tu equipo. No sustituye a tu cocina ni a tu caja.
              </p>
            </div>
            <ul className="space-y-3">
              {[
                ["No cobra en línea", "El pago es al recoger o al recibir (efectivo, tarjeta o transferencia, según lo que aceptes). No hay pagos con tarjeta dentro del chat."],
                ["No es un punto de venta", "No lleva tu caja, tu inventario ni imprime comandas, y no hace facturas. El tablero es para atender los pedidos que entran por Jovia."],
                ["No reparte ni rastrea", "Marcas el pedido «en camino» y el cliente recibe el aviso, pero no hay mapa ni seguimiento en vivo del repartidor."],
                ["Las zonas son por colonia", "Cubres las colonias que des de alta con su costo de envío; no calcula distancias."],
                ["Reserva por aforo, no por mesa", "Cuida que no pases tu capacidad; no asigna mesas ni lleva un plano del salón."],
              ].map(([t, d]) => (
                <li key={t} className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
                  <p className="font-semibold text-slate-900">{t}</p>
                  <p className="mt-0.5 text-sm leading-relaxed text-slate-600">{d}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ------------------------------------------------------------ precio */}
        <section id="precio" className="scroll-mt-20 bg-gradient-to-b from-slate-50 to-white">
          <div className="mx-auto max-w-3xl px-4 py-16 text-center sm:px-6 lg:py-20">
            <SectionTitle kicker="Precio" title={`Desde $${basic.priceMxn.toLocaleString("es-MX")} pesos al mes`} />
            <p className="mx-auto mt-3 max-w-xl text-slate-600">
              {TRIAL_DAYS} días de prueba sin tarjeta, sin plazo forzoso. Hay planes con mejor redacción de la IA y soporte prioritario; los ves al crear tu cuenta. Precios en pesos mexicanos al mes, IVA incluido.
            </p>
            <div className="mx-auto mt-8 max-w-2xl rounded-xl bg-white p-5 text-left text-sm leading-relaxed text-slate-600 ring-1 ring-slate-200">
              <p className="font-semibold text-slate-800">Lo que se paga aparte, con transparencia</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li><b>Mensajes de WhatsApp:</b> Meta cobra directamente a tu cuenta algunos mensajes. Las primeras 1,000 respuestas al mes por número son gratis; después, centavos por mensaje. Necesitas un método de pago en tu cuenta de Meta.</li>
                <li><b>Llamadas con IA:</b> se contratan como complemento, por minutos.</li>
              </ul>
            </div>
            <a href={signup("restaurante")} className="mt-8 inline-flex rounded-xl bg-teal-700 px-6 py-3.5 text-base font-semibold text-white shadow-sm hover:bg-teal-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2">
              Probar {TRIAL_DAYS} días gratis
            </a>
          </div>
        </section>

        {/* ------------------------------------------------------------ preguntas */}
        <section id="preguntas" className="scroll-mt-20 mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:py-20">
          <SectionTitle kicker="Preguntas frecuentes" title="Lo que casi todos los restaurantes preguntan" />
          <div className="mt-10 divide-y divide-slate-200 rounded-2xl bg-white ring-1 ring-slate-200">
            {FAQ.map(([q, a]) => (
              <details key={q} className="group px-5 py-4 [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[15px] font-semibold text-slate-900">
                  {q}
                  <span aria-hidden className="shrink-0 text-xl leading-none text-teal-700 transition-transform group-open:rotate-45">+</span>
                </summary>
                <p className="mt-3 text-[15px] leading-relaxed text-slate-600">{a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------------------ cierre */}
        <section className="px-4 pb-16 sm:px-6 lg:pb-24">
          <div className="mx-auto max-w-5xl overflow-hidden rounded-3xl bg-gradient-to-br from-teal-700 to-teal-900 px-6 py-14 text-center text-white shadow-lg sm:px-12">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-4xl">Que tu equipo cocine y Jovia conteste</h2>
            <p className="mx-auto mt-4 max-w-xl text-teal-50">Crea tu cuenta en un minuto y prueba Jovia {TRIAL_DAYS} días, sin dar tarjeta.</p>
            <a href={signup("restaurante")} className="mt-8 inline-flex rounded-xl bg-white px-7 py-3.5 text-base font-semibold text-teal-900 shadow-sm hover:bg-teal-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-teal-800">
              Crear mi cuenta gratis
            </a>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-slate-500 sm:flex-row sm:px-6">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-teal-700 text-sm font-bold text-white">J</span>
            <span>© {new Date().getFullYear()} Jovia · México</span>
          </div>
          <nav aria-label="Pie de página" className="flex flex-wrap justify-center gap-x-6 gap-y-2">
            <a className="hover:text-teal-800" href="/">Jovia para otros negocios</a>
            <a className="hover:text-teal-800" href="/privacidad">Aviso de privacidad</a>
            <a className="hover:text-teal-800" href="/terminos">Condiciones del servicio</a>
            <a className="hover:text-teal-800" href="/login">Iniciar sesión</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

const FAQ: Array<[string, string]> = [
  ["¿Puede equivocarse en el pedido?", "Está hecha para no adivinar: los platillos, modificadores y precios salen de tu menú, el total lo calcula el sistema y el pedido solo se crea cuando el cliente confirma el resumen. Aun así puedes empezar en modo «copiloto» y aprobar cada respuesta."],
  ["¿Qué pasa si se acaba un platillo?", "Lo marcas como agotado con un interruptor y el asistente deja de ofrecerlo y le dice al cliente que hoy no hay. Lo mismo con una opción, como una tortilla o un extra."],
  ["¿Y si el cliente tiene una alergia?", "No recomienda nada que el menú no diga. Ante una alergia, intolerancia o dieta especial, te avisa y pasa la conversación a una persona de tu equipo."],
  ["¿Toma pagos?", "No cobra en línea. El cliente paga al recoger o al recibir, con las formas de pago que tú actives (efectivo, tarjeta, transferencia). Si aceptas transferencia, el asistente le da tus datos para transferir."],
  ["¿Cómo sé que entró un pedido?", "Aparece al instante en el tablero de Pedidos (con un sonido opcional) y, si quieres, te llega un correo por cada pedido nuevo. Cuando lo marcas listo o en camino, al cliente le llega el aviso."],
  ["¿Puedo pausar los pedidos si estamos saturados?", "Sí, con un interruptor. Mientras está pausado, el asistente le avisa al cliente y no toma pedidos nuevos. También respeta tu horario: fuera de él no toma pedidos."],
  ["¿Cómo funcionan las zonas de entrega?", "Das de alta las colonias que cubres, cada una con su costo de envío (y, si quieres, un pedido mínimo). Si la colonia del cliente no está, el asistente se lo dice y le ofrece pasar a recoger."],
  ["¿Necesito cambiar mi número de WhatsApp?", "No. Conectas el número de WhatsApp Business de tu negocio a tu cuenta de Meta. Si necesitas ayuda, te acompañamos en la conexión."],
  ["¿Mis clientes sabrán que hablan con una IA?", "Sí. Se presenta como asistente virtual en su primer mensaje. Nunca finge ser una persona."],
  ["¿Puedo cancelar cuando quiera?", "Sí, sin plazo forzoso. Si cancelas, conservas el acceso hasta el final del periodo que ya pagaste."],
];

