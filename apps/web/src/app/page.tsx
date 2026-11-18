import { PLANS, PLAN_IDS, TRIAL_DAYS } from "@empleado/shared/plans";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getValidSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const TITLE = "Tamia · Tu recepcionista con IA para WhatsApp y llamadas";
const DESCRIPTION =
  "Tamia contesta a tus pacientes por WhatsApp, agenda sus citas y les manda recordatorios, las 24 horas. Para clínicas dentales y negocios con citas. Pruébalo 14 días gratis.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  robots: { index: true, follow: true },
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website", locale: "es_MX", siteName: "Tamia" },
  alternates: { canonical: "https://www.tamia.com.mx" },
};

/** Inicio publico (www.tamia.com.mx). Con sesion va directo al panel; el panel (app.…) sin sesion va al login. */
export default async function Landing() {
  const host = ((await headers()).get("x-forwarded-host") ?? (await headers()).get("host") ?? "").toLowerCase();
  if (await getValidSession()) redirect("/bandeja");
  if (host.startsWith("app.")) redirect("/login");

  // En www.tamia.com.mx la cuenta y el panel viven en app.tamia.com.mx; en otro host (local) se usan rutas relativas.
  const app = host.startsWith("www.") ? `https://app.${host.slice(4)}` : "";
  const signup = `${app}/registro`;
  const login = `${app}/login`;

  return (
    <div className="min-h-full bg-white text-slate-900">
      {/* ------------------------------------------------------------ encabezado */}
      <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <a href="#inicio" className="flex items-center gap-2.5" aria-label="Tamia, inicio">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-700 text-lg font-bold text-white">T</span>
            <span className="text-lg font-semibold tracking-tight">Tamia</span>
          </a>
          <nav aria-label="Secciones" className="hidden items-center gap-7 text-sm font-medium text-slate-600 md:flex">
            <a className="hover:text-teal-800" href="#como-funciona">Cómo funciona</a>
            <a className="hover:text-teal-800" href="#que-incluye">Qué incluye</a>
            <a className="hover:text-teal-800" href="#precios">Precios</a>
            <a className="hover:text-teal-800" href="#preguntas">Preguntas</a>
          </nav>
          <div className="flex items-center gap-2 sm:gap-3">
            <a href={login} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">Iniciar sesión</a>
            <a href={signup} className="rounded-lg bg-teal-700 px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-teal-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2">
              Probar gratis
            </a>
          </div>
        </div>
      </header>

      <main id="inicio">
        {/* ------------------------------------------------------------ héroe */}
        <section className="relative overflow-hidden bg-gradient-to-b from-teal-50 via-white to-white">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-12 sm:px-6 md:pt-20 lg:grid-cols-[1.05fr_0.95fr] lg:pb-24">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full bg-teal-100/70 px-3 py-1 text-xs font-semibold text-teal-900">
                <span className="h-1.5 w-1.5 rounded-full bg-teal-600" /> Para clínicas dentales y negocios con citas
              </p>
              <h1 className="mt-5 text-4xl font-semibold leading-[1.1] tracking-tight text-slate-900 sm:text-5xl">
                Tu recepcionista con inteligencia artificial,{" "}
                <span className="text-teal-700">siempre disponible</span>
              </h1>
              <p className="mt-5 max-w-xl text-lg leading-relaxed text-slate-600">
                Tamia contesta a tus pacientes por WhatsApp, resuelve sus dudas, <strong className="font-semibold text-slate-800">agenda sus citas</strong> y les manda recordatorios. Tú atiendes a quien está en el sillón; ella atiende al resto.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                <a href={signup} className="inline-flex items-center justify-center rounded-xl bg-teal-700 px-6 py-3.5 text-base font-semibold text-white shadow-sm hover:bg-teal-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2">
                  Prueba {TRIAL_DAYS} días gratis
                </a>
                <a href="#como-funciona" className="inline-flex items-center justify-center rounded-xl px-5 py-3.5 text-base font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50">
                  Ver cómo funciona
                </a>
              </div>
              <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600">
                {["Sin tarjeta para empezar", "Se configura en minutos", "Cancelas cuando quieras"].map((t) => (
                  <li key={t} className="flex items-center gap-1.5"><Check /> {t}</li>
                ))}
              </ul>
            </div>

            {/* Ejemplo de conversación (ilustrativo) */}
            <div className="relative mx-auto w-full max-w-md" aria-label="Ejemplo de una conversación de WhatsApp con Tamia">
              <div className="absolute -inset-4 -z-10 rounded-[2rem] bg-gradient-to-br from-teal-200/50 to-emerald-100/40 blur-2xl" />
              <div className="overflow-hidden rounded-3xl bg-white shadow-xl ring-1 ring-slate-200">
                <div className="flex items-center gap-3 bg-teal-700 px-4 py-3 text-white">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-sm font-semibold">S</span>
                  <div className="leading-tight">
                    <p className="text-sm font-semibold">Clínica Dental Sonrisa</p>
                    <p className="text-xs text-teal-100">asistente virtual · en línea</p>
                  </div>
                </div>
                <div className="space-y-2.5 bg-[#efeae2] p-4 text-[13.5px] leading-snug">
                  <Bubble who="in">Hola, quiero una limpieza dental para mañana por la tarde 🙂</Bubble>
                  <Bubble who="out">¡Hola! Soy Sonri, la asistente virtual de la clínica. Mañana tengo libre a las <b>4:00</b>, <b>4:45</b> o <b>5:30 pm</b> con la Dra. Ruiz. ¿Cuál te acomoda?</Bubble>
                  <Bubble who="in">A las 4:45</Bubble>
                  <Bubble who="out">Perfecto. ¿Me das tu nombre completo para apartarla?</Bubble>
                  <Bubble who="in">Laura Méndez</Bubble>
                  <Bubble who="out">Listo, Laura: tu <b>limpieza dental</b> quedó mañana a las <b>4:45 pm</b> con la Dra. Ruiz. Te mando un recordatorio antes. ✅</Bubble>
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
              Un mensaje sin respuesta es un paciente que se va con otra clínica
            </h2>
            <div className="mt-10 grid gap-5 sm:grid-cols-3">
              <Pain title="Escriben cuando tú no puedes" text="En la noche, en domingo o con la recepción ocupada. Quien pregunta por una cita casi siempre le escribe a más de una clínica." />
              <Pain title="Siempre las mismas preguntas" text="Precios, horarios, ubicación, formas de pago. Tu equipo las contesta decenas de veces a la semana." />
              <Pain title="Citas que se pierden" text="Sin recordatorio, la gente olvida su cita. Cada hueco vacío en la agenda es dinero que no regresa." />
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ cómo funciona */}
        <section id="como-funciona" className="scroll-mt-20 mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
          <SectionTitle kicker="Cómo funciona" title="De cero a atender pacientes, en tres pasos" />
          <ol className="mt-12 grid gap-6 md:grid-cols-3">
            {[
              ["1", "Crea tu cuenta", `Registra tu clínica en un minuto. Tienes ${TRIAL_DAYS} días de prueba sin dar tarjeta. Revisamos cada cuenta nueva y la activamos, normalmente el mismo día hábil.`],
              ["2", "Cuéntale cómo trabajas", "Carga tus servicios, precios, horarios y especialistas, y conecta tu número de WhatsApp. Ella solo responde con lo que tú le enseñas."],
              ["3", "Ella atiende, tú decides", "Contesta, agenda y recuerda. Empieza en modo «copiloto» (tú apruebas cada respuesta) y pasa a automático cuando confíes en ella."],
            ].map(([n, t, d]) => (
              <li key={n} className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-teal-700 text-base font-semibold text-white">{n}</span>
                <h3 className="mt-4 text-lg font-semibold">{t}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-slate-600">{d}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ------------------------------------------------------------ qué incluye */}
        <section id="que-incluye" className="scroll-mt-20 bg-slate-50">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
            <SectionTitle kicker="Qué incluye" title="Todo lo que necesita una recepción, sin contratar a nadie más" />
            <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              <Feature icon={<IconChat />} title="Atiende por WhatsApp" text="Contesta en segundos, con un tono amable, y entiende notas de voz. Usa el número de WhatsApp Business de tu clínica." />
              <Feature icon={<IconCalendar />} title="Agenda citas reales" text="Ofrece solo horarios libres según tu agenda, tus especialistas y tus festivos. Nunca empalma dos citas." />
              <Feature icon={<IconBell />} title="Recordatorios automáticos" text="Avisa a tus pacientes un día antes y unas horas antes de su cita, y les deja confirmar o cancelar." />
              <Feature icon={<IconUser />} title="Pasa a una persona cuando hace falta" text="Si hay una queja, una urgencia o algo que no sabe, no inventa: te avisa y te deja un resumen de lo que quiere el paciente y por qué lo pasó." />
              <Feature icon={<IconShield />} title="Tú tienes el control" text="Elige cuánta libertad le das: aprobar cada respuesta, solo las de agenda, o que trabaje sola. Puedes tomar cualquier conversación cuando quieras." />
              <Feature icon={<IconChart />} title="Estadísticas de tu clínica" text="Mensajes atendidos, citas agendadas, tiempo de respuesta y seguimiento, para ver cuánto trabajo te quita." />
              <Feature icon={<IconPhone />} title="Atiende llamadas" tag="Complemento" text="Una voz con acento mexicano contesta el teléfono, resuelve dudas y agenda. Se contrata aparte; pregúntanos." />
              <Feature icon={<IconFacebook />} title="Messenger e Instagram" tag="Próximamente" text="La misma asistente, en los mensajes de tu página de Facebook y de tu Instagram, en la misma bandeja." />
              <Feature icon={<IconSync />} title="Se lleva bien con tu calendario" text="Las citas confirmadas pueden aparecer en tu Google Calendar para que nadie tenga que capturarlas dos veces." />
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ confianza */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
          <div className="grid items-center gap-10 lg:grid-cols-2">
            <div>
              <SectionTitle kicker="Pensado para clínicas" title="Cuida a tus pacientes tanto como tú" align="left" />
              <p className="mt-5 text-[15px] leading-relaxed text-slate-600">
                Tamia no es un chatbot genérico. Conoce los servicios y horarios de <em>tu</em> clínica, y está hecha para no inventar precios, horarios ni consejos médicos.
              </p>
            </div>
            <ul className="space-y-4">
              {[
                ["No inventa", "Responde con los datos que cargaste. Si no los tiene, avisa a tu equipo en lugar de adivinar."],
                ["No da diagnósticos", "Ante dolor intenso o urgencias, pasa de inmediato la conversación a una persona de tu equipo."],
                ["Datos de tu clínica, separados de los demás", "Cada negocio tiene su información aislada y protegida, y los accesos se guardan cifrados."],
                ["Tú decides", "Puedes revisar cada conversación y cada decisión que tomó."],
              ].map(([t, d]) => (
                <li key={t} className="flex gap-3 rounded-xl bg-white p-4 ring-1 ring-slate-200">
                  <span className="mt-0.5 shrink-0"><Check /></span>
                  <div>
                    <p className="font-semibold text-slate-900">{t}</p>
                    <p className="mt-0.5 text-sm leading-relaxed text-slate-600">{d}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ------------------------------------------------------------ precios */}
        <section id="precios" className="scroll-mt-20 bg-gradient-to-b from-slate-50 to-white">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
            <SectionTitle kicker="Precios" title="Empieza gratis. Elige el plan cuando estés listo." />
            <p className="mx-auto mt-3 max-w-xl text-center text-slate-600">{TRIAL_DAYS} días de prueba sin tarjeta. Precios en pesos mexicanos al mes, IVA incluido. Sin plazo forzoso.</p>
            <div className="mt-12 grid gap-6 lg:grid-cols-3">
              {PLAN_IDS.map((id) => {
                const p = PLANS[id];
                const featured = id === "profesional";
                return (
                  <div key={id} className={`relative flex flex-col rounded-2xl bg-white p-7 ring-1 ${featured ? "shadow-lg ring-2 ring-teal-600" : "shadow-sm ring-slate-200"}`}>
                    {featured && <span className="absolute -top-3 left-7 rounded-full bg-teal-700 px-3 py-0.5 text-xs font-semibold text-white">Recomendado</span>}
                    <h3 className="text-lg font-semibold">{p.name}</h3>
                    <p className="mt-1 text-sm text-slate-500">{p.tagline}</p>
                    <p className="mt-5 flex items-baseline gap-1">
                      <span className="text-4xl font-semibold tracking-tight">${p.priceMxn.toLocaleString("es-MX")}</span>
                      <span className="text-sm text-slate-500">MXN / mes</span>
                    </p>
                    <ul className="mt-6 flex-1 space-y-2.5 text-[15px] text-slate-700">
                      {p.features.map((f) => (
                        <li key={f} className="flex gap-2"><span className="mt-1 shrink-0"><Check /></span>{f}</li>
                      ))}
                    </ul>
                    <a href={signup} className={`mt-7 inline-flex justify-center rounded-xl px-5 py-3 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2 ${featured ? "bg-teal-700 text-white hover:bg-teal-800" : "text-teal-800 ring-1 ring-teal-700/40 hover:bg-teal-50"}`}>
                      Probar {TRIAL_DAYS} días gratis
                    </a>
                  </div>
                );
              })}
            </div>
            <div className="mx-auto mt-8 max-w-3xl rounded-xl bg-white p-5 text-sm leading-relaxed text-slate-600 ring-1 ring-slate-200">
              <p className="font-semibold text-slate-800">Lo que se paga aparte, con transparencia</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li><b>Mensajes de WhatsApp:</b> Meta cobra directamente a tu cuenta algunos mensajes. Las primeras 1,000 respuestas al mes por número son gratis; después, centavos por mensaje, igual que los recordatorios de cita. Necesitas un método de pago en tu cuenta de Meta.</li>
                <li><b>Llamadas con IA:</b> se contratan como complemento, por minutos.</li>
              </ul>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ preguntas */}
        <section id="preguntas" className="scroll-mt-20 mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:py-20">
          <SectionTitle kicker="Preguntas frecuentes" title="Lo que casi todos preguntan" />
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
            <h2 className="text-2xl font-semibold tracking-tight sm:text-4xl">Que ningún mensaje se quede sin respuesta</h2>
            <p className="mx-auto mt-4 max-w-xl text-teal-50">Crea tu cuenta en un minuto y prueba Tamia {TRIAL_DAYS} días, sin dar tarjeta.</p>
            <a href={signup} className="mt-8 inline-flex rounded-xl bg-white px-7 py-3.5 text-base font-semibold text-teal-900 shadow-sm hover:bg-teal-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-teal-800">
              Crear mi cuenta gratis
            </a>
          </div>
        </section>
      </main>

      {/* ------------------------------------------------------------ pie */}
      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-slate-500 sm:flex-row sm:px-6">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-teal-700 text-sm font-bold text-white">T</span>
            <span>© {new Date().getFullYear()} Tamia · México</span>
          </div>
          <nav aria-label="Pie de página" className="flex flex-wrap justify-center gap-x-6 gap-y-2">
            <a className="hover:text-teal-800" href="/privacidad">Aviso de privacidad</a>
            <a className="hover:text-teal-800" href={login}>Iniciar sesión</a>
            <a className="hover:text-teal-800" href={signup}>Crear cuenta</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ datos */

const FAQ: Array<[string, string]> = [
  ["¿Necesito tarjeta para probarlo?", `No. Tienes ${TRIAL_DAYS} días de prueba sin tarjeta. Al terminar eliges un plan; si no lo haces, el asistente simplemente deja de responder.`],
  ["¿Cuánto tarda en estar funcionando?", "Crear la cuenta toma un minuto. Revisamos cada cuenta nueva antes de activarla (normalmente el mismo día hábil). Mientras tanto puedes cargar tus servicios, horarios y preguntas frecuentes."],
  ["¿Puede equivocarse o inventar cosas?", "Está diseñada para contestar solo con la información que tú le cargas: servicios, precios, horarios y políticas. Si no la tiene, o si el paciente se queja o tiene una urgencia, te avisa y te pasa la conversación con un resumen. Además puedes empezar en modo «copiloto» y aprobar cada respuesta."],
  ["¿Mis pacientes sabrán que hablan con una IA?", "Sí. Se presenta como asistente virtual en su primer mensaje. Nunca finge ser una persona."],
  ["¿Necesito cambiar mi número de WhatsApp?", "No. Conectas el número de WhatsApp Business de tu clínica a tu cuenta de Meta. Si necesitas ayuda, te acompañamos en la conexión."],
  ["¿Qué pasa con los datos de mis pacientes?", "Cada clínica tiene su información separada de las demás y los accesos se guardan cifrados. Lee nuestro aviso de privacidad para el detalle: puedes pedir que borremos tus datos cuando quieras."],
  ["¿Funciona solo para dentistas?", "Hoy está afinada para clínicas dentales, pero también sirve para consultorios y otros negocios que trabajan con citas: tú le cargas tus propios servicios y horarios."],
  ["¿Puedo cancelar cuando quiera?", "Sí, sin plazo forzoso. Si cancelas, conservas el acceso hasta el final del periodo que ya pagaste."],
];

/* ------------------------------------------------------------------ piezas */

function SectionTitle({ kicker, title, align = "center" }: { kicker: string; title: string; align?: "center" | "left" }) {
  return (
    <div className={align === "center" ? "mx-auto max-w-2xl text-center" : ""}>
      <p className="text-sm font-semibold uppercase tracking-wider text-teal-700">{kicker}</p>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">{title}</h2>
    </div>
  );
}

function Pain({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-2xl bg-white p-6 ring-1 ring-slate-200">
      <h3 className="font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 text-[15px] leading-relaxed text-slate-600">{text}</p>
    </div>
  );
}

function Feature({ icon, title, text, tag }: { icon: React.ReactNode; title: string; text: string; tag?: string }) {
  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <div className="flex items-center justify-between">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-teal-50 text-teal-700">{icon}</span>
        {tag && <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-900">{tag}</span>}
      </div>
      <h3 className="mt-4 font-semibold text-slate-900">{title}</h3>
      <p className="mt-1.5 text-[15px] leading-relaxed text-slate-600">{text}</p>
    </div>
  );
}

function Bubble({ who, children }: { who: "in" | "out"; children: React.ReactNode }) {
  return (
    <div className={`flex ${who === "out" ? "justify-end" : "justify-start"}`}>
      <p className={`max-w-[85%] rounded-2xl px-3 py-2 shadow-sm ${who === "out" ? "rounded-tr-sm bg-[#d9fdd3]" : "rounded-tl-sm bg-white"}`}>{children}</p>
    </div>
  );
}

const icon = "h-5 w-5";
const svg = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", viewBox: "0 0 24 24", "aria-hidden": true } as const;

function Check() {
  return (
    <svg className="h-4 w-4 text-teal-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z" clipRule="evenodd" />
    </svg>
  );
}
const IconChat = () => <svg className={icon} {...svg}><path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.6A8 8 0 1 1 21 12Z" /></svg>;
const IconCalendar = () => <svg className={icon} {...svg}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18M9 15l2 2 4-4" /></svg>;
const IconBell = () => <svg className={icon} {...svg}><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8ZM10.3 20a2 2 0 0 0 3.4 0" /></svg>;
const IconUser = () => <svg className={icon} {...svg}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
const IconShield = () => <svg className={icon} {...svg}><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" /><path d="m9 12 2 2 4-4" /></svg>;
const IconChart = () => <svg className={icon} {...svg}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>;
const IconPhone = () => <svg className={icon} {...svg}><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z" /></svg>;
const IconFacebook = () => <svg className={icon} {...svg}><circle cx="12" cy="12" r="9" /><path d="M13.5 8H15V5.5h-1.5A3 3 0 0 0 10.5 8.5V10H9v2.5h1.5V19h2.5v-6.5H15L15.5 10h-2.5V8.7c0-.4.2-.7.5-.7Z" /></svg>;
const IconSync = () => <svg className={icon} {...svg}><path d="M21 12a9 9 0 0 1-15.4 6.4L3 16M3 12a9 9 0 0 1 15.4-6.4L21 8M3 21v-5h5M21 3v5h-5" /></svg>;
