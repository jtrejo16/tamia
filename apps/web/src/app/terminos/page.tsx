import type { Metadata } from "next";
import { TRIAL_DAYS } from "@empleado/shared/plans";

// Pagina PUBLICA (sin sesion): Google y Meta piden una direccion publica de las Condiciones del Servicio.
export const metadata: Metadata = {
  title: "Condiciones del servicio · Jovia",
  description: "Las reglas para usar Jovia, el servicio de recepción con inteligencia artificial para negocios con citas.",
  robots: { index: true, follow: true },
  alternates: { canonical: "/terminos" },
};

const UPDATED = "20 de noviembre de 2026";

function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 space-y-2">
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <div className="space-y-2 text-[15px] leading-relaxed text-slate-700">{children}</div>
    </section>
  );
}

const Li = ({ children }: { children: React.ReactNode }) => <li className="ml-5 list-disc">{children}</li>;

export default function TermsPage() {
  const email = process.env.PRIVACY_CONTACT_EMAIL?.trim();
  const legalName = process.env.LEGAL_NAME?.trim() || "Jovia";
  const contact = email ? (
    <a className="font-medium text-teal-800 underline" href={`mailto:${email}`}>{email}</a>
  ) : (
    <span>el canal de soporte que aparece en tu panel de Jovia</span>
  );

  return (
    <main className="min-h-screen bg-slate-50">
      <article className="mx-auto max-w-3xl space-y-8 px-4 py-10 sm:px-6 sm:py-14">
        <header className="space-y-2">
          <p className="text-sm font-medium text-teal-800">Jovia · www.jovia.mx</p>
          <h1 className="text-3xl font-semibold text-slate-900">Condiciones del servicio</h1>
          <p className="text-sm text-slate-500">Última actualización: {UPDATED}</p>
        </header>

        <Section title="1. Quiénes somos y qué aceptas">
          <p>
            Jovia es un servicio de recepción con inteligencia artificial para negocios que trabajan con citas o reservas. Contesta mensajes de WhatsApp, Messenger e Instagram y llamadas telefónicas, agenda citas y
            manda recordatorios en nombre del negocio. El servicio lo opera {legalName} («Jovia», «nosotros»).
          </p>
          <p>
            Al crear una cuenta o usar Jovia aceptas estas condiciones y el <a className="text-teal-800 underline" href="/privacidad">aviso de privacidad</a>. Si usas Jovia en nombre de un negocio, declaras que tienes
            facultades para obligarlo. Si no estás de acuerdo, no uses el servicio.
          </p>
        </Section>

        <Section title="2. Tu cuenta">
          <ul>
            <Li>Debes dar datos verdaderos y mantenerlos al día. Revisamos cada cuenta nueva antes de activarla y podemos rechazarla.</Li>
            <Li>Eres responsable de la confidencialidad de tu contraseña y de lo que se haga con tu cuenta. Avísanos de inmediato si sospechas un uso no autorizado.</Li>
            <Li>Jovia es para negocios. No está dirigido a menores de edad.</Li>
          </ul>
        </Section>

        <Section title="3. Cómo funciona el asistente">
          <ul>
            <Li>El asistente usa inteligencia artificial y <b>puede equivocarse</b>. Tú decides su nivel de autonomía; con la aprobación activada, una persona de tu equipo revisa lo que propone antes de que se ejecute.</Li>
            <Li>Jovia no sustituye el criterio de un profesional. En particular, no da diagnósticos, recomendaciones médicas, legales ni financieras, y no sirve para atender emergencias.</Li>
            <Li>Eres responsable de la información que cargas (servicios, precios, horarios, políticas) porque el asistente la usa para contestar a tus clientes. Mantenla correcta.</Li>
            <Li>Cuando una persona pide hablar con alguien, o la situación lo requiere, el asistente la pasa al equipo y avisa por los medios que configuraste. Que el aviso llegue depende también de servicios de terceros.</Li>
          </ul>
        </Section>

        <Section title="4. Uso aceptable">
          <p>Te comprometes a no usar Jovia para:</p>
          <ul>
            <Li>Actividades ilegales, engañosas o que perjudiquen a terceros, incluido el envío de mensajes no solicitados (spam) o de promociones masivas.</Li>
            <Li>Incumplir las reglas de los canales que conectas, como las políticas de WhatsApp Business, Messenger e Instagram de Meta, o las de Google.</Li>
            <Li>Tratar datos personales sin tener derecho a hacerlo. Eres responsable de informar a tus clientes, cuando corresponda, que los atiende un asistente virtual y de contar con su consentimiento para los recordatorios.</Li>
            <Li>Intentar acceder a datos de otros negocios, interferir con el servicio, hacer ingeniería inversa o sobrecargarlo de forma abusiva.</Li>
          </ul>
        </Section>

        <Section title="5. Servicios de terceros">
          <p>
            Jovia funciona con servicios de terceros: Meta (WhatsApp, Messenger e Instagram), proveedores de inteligencia artificial, de telefonía y de voz, Google (Calendar), Mercado Pago y Railway. Sus propias condiciones
            aplican a su parte del servicio, y pueden generar cargos propios (por ejemplo, mensajes de plantilla de WhatsApp o minutos de llamada). No controlamos esos servicios: si uno falla, cambia o deja de ofrecerse, el
            funcionamiento de Jovia puede verse afectado.
          </p>
        </Section>

        <Section title="6. Planes, prueba y pagos">
          <ul>
            <Li>Puedes probar Jovia {TRIAL_DAYS} días sin dar tarjeta. Al terminar la prueba, necesitas una suscripción para seguir usándolo.</Li>
            <Li>Las suscripciones se cobran por medio de Mercado Pago, con el precio y el periodo del plan que elijas. Jovia no guarda los datos de tu tarjeta.</Li>
            <Li>Si un cobro no se completa, podemos limitar o suspender el servicio hasta que se regularice.</Li>
            <Li>Podemos cambiar los precios o los planes avisándote con anticipación razonable; el cambio aplica desde tu siguiente periodo.</Li>
          </ul>
        </Section>

        <Section title="7. Cancelación y suspensión">
          <ul>
            <Li>Puedes cancelar tu suscripción cuando quieras. La cancelación surte efecto al terminar el periodo ya pagado.</Li>
            <Li>Podemos suspender o cerrar una cuenta si incumples estas condiciones, si hay un uso que ponga en riesgo el servicio o a terceros, o si lo exige la ley o un proveedor del que dependemos.</Li>
            <Li>Al cerrar la cuenta puedes pedir que eliminemos tus datos, como explica el aviso de privacidad.</Li>
          </ul>
        </Section>

        <Section title="8. Disponibilidad">
          <p>
            Procuramos que Jovia esté disponible todo el tiempo, pero no garantizamos que funcione sin interrupciones ni errores. Puede haber mantenimientos, fallas propias o de terceros. Para casos que no pueden
            esperar, mantén siempre una forma alterna de atender a tus clientes.
          </p>
        </Section>

        <Section title="9. Propiedad intelectual">
          <p>
            Jovia, su software, marca y diseño son de {legalName}. Te damos un derecho limitado, no exclusivo y revocable para usar el servicio mientras tengas una cuenta vigente. Tú conservas todos los derechos sobre tu
            información y la de tus clientes, y nos autorizas a tratarla únicamente para prestarte el servicio.
          </p>
        </Section>

        <Section title="10. Limitación de responsabilidad">
          <p>
            Jovia se ofrece «tal cual». En la medida que la ley lo permita, no somos responsables por pérdidas indirectas, citas perdidas, ingresos no percibidos o daños derivados de errores del asistente, de mensajes que no
            lleguen o de fallas de servicios de terceros. Nuestra responsabilidad total frente a ti por cualquier reclamación se limita a lo que hayas pagado por el servicio en los tres meses anteriores al hecho.
            Nada de esto limita responsabilidades que la ley no permita limitar.
          </p>
        </Section>

        <Section title="11. Cambios a estas condiciones">
          <p>
            Podemos actualizar estas condiciones. Publicaremos la versión vigente en esta página con su fecha y avisaremos a los negocios si el cambio es importante. Si sigues usando Jovia después del cambio, lo
            aceptas.
          </p>
        </Section>

        <Section title="12. Ley aplicable y contacto">
          <p>
            Estas condiciones se rigen por las leyes de los Estados Unidos Mexicanos. Para cualquier controversia, las partes se someten a los tribunales competentes de México, renunciando a cualquier otro fuero.
          </p>
          <p>Dudas sobre estas condiciones: {contact}.</p>
        </Section>
      </article>
    </main>
  );
}
