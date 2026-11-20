import type { Metadata } from "next";

// Pagina PUBLICA (sin sesion): Meta, Google y Mercado Pago piden una direccion publica de la politica de privacidad.
export const metadata: Metadata = {
  title: "Aviso de privacidad · Tamia",
  description: "Cómo Tamia trata los datos de los negocios que la usan y de las personas que les escriben o llaman.",
  robots: { index: true, follow: true },
};

const UPDATED = "18 de noviembre de 2026";

function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 space-y-2">
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <div className="space-y-2 text-[15px] leading-relaxed text-slate-700">{children}</div>
    </section>
  );
}

const Li = ({ children }: { children: React.ReactNode }) => <li className="ml-5 list-disc">{children}</li>;

export default function PrivacyPage() {
  const email = process.env.PRIVACY_CONTACT_EMAIL?.trim();
  const legalName = process.env.LEGAL_NAME?.trim() || "Tamia";
  const contact = email ? (
    <a className="font-medium text-teal-800 underline" href={`mailto:${email}`}>{email}</a>
  ) : (
    <span>el canal de soporte que aparece en tu panel de Tamia</span>
  );

  return (
    <main className="min-h-screen bg-slate-50">
      <article className="mx-auto max-w-3xl space-y-8 px-4 py-10 sm:px-6 sm:py-14">
        <header className="space-y-2">
          <p className="text-sm font-medium text-teal-800">Tamia · www.jovia.mx</p>
          <h1 className="text-3xl font-semibold text-slate-900">Aviso de privacidad</h1>
          <p className="text-sm text-slate-500">Última actualización: {UPDATED}</p>
        </header>

        <Section title="1. Quiénes somos">
          <p>
            Tamia es un servicio de recepción con inteligencia artificial para negocios (por ejemplo, consultorios y clínicas). Contesta mensajes de WhatsApp, Messenger e Instagram y llamadas
            telefónicas, y agenda citas en nombre del negocio. El servicio lo opera {legalName} («Tamia», «nosotros»).
          </p>
          <p>
            Hay dos tipos de personas cuyos datos tratamos: <b>(a) los negocios que contratan Tamia</b> y sus usuarios, y <b>(b) las personas que le escriben o llaman a esos negocios</b> (por ejemplo, pacientes).
            Con respecto a (a) somos responsables del tratamiento. Con respecto a (b), Tamia actúa por cuenta del negocio, que es quien decide para qué se usan esos datos; nosotros los tratamos únicamente para prestarle el servicio.
          </p>
        </Section>

        <Section title="2. Qué datos tratamos">
          <p className="font-medium text-slate-800">De los negocios que contratan Tamia</p>
          <ul>
            <Li>Nombre del negocio, correo, nombre y contraseña (guardada de forma cifrada) de sus usuarios.</Li>
            <Li>Datos de la suscripción (plan, fechas de cobro y estado). Los datos de la tarjeta los procesa Mercado Pago; Tamia no los guarda.</Li>
            <Li>Los accesos que el negocio autoriza (WhatsApp, página de Facebook, cuenta de Instagram, Google Calendar), guardados cifrados.</Li>
            <Li>Servicios, horarios, preguntas frecuentes y otra información que el negocio nos da para que el asistente conteste.</Li>
          </ul>
          <p className="font-medium text-slate-800">De las personas que escriben o llaman a un negocio</p>
          <ul>
            <Li>Nombre de perfil y número de teléfono (WhatsApp) o identificador de la cuenta (Messenger, Instagram).</Li>
            <Li>El contenido de los mensajes, incluidas notas de voz transcritas, y lo que la persona comparta durante la conversación (por ejemplo, el motivo de una cita).</Li>
            <Li>En llamadas: el número desde el que se llama, la duración, el resumen y la transcripción. El proveedor de voz puede conservar también el audio de la llamada.</Li>
            <Li>Los datos de las citas que se agendan (nombre, teléfono, servicio, fecha y hora).</Li>
          </ul>
          <p>
            Es posible que una conversación incluya datos relacionados con la salud (por ejemplo, el motivo de una consulta). Tamia no pide estos datos por sí misma ni los usa para otra finalidad: los
            trata solo para atender la conversación y agendar la cita, por cuenta del negocio.
          </p>
        </Section>

        <Section title="3. Para qué los usamos">
          <ul>
            <Li>Contestar mensajes y llamadas, agendar, confirmar y recordar citas, y avisar al equipo del negocio cuando una persona debe intervenir.</Li>
            <Li>Mostrar al negocio sus conversaciones, citas y estadísticas de uso.</Li>
            <Li>Cobrar la suscripción, dar soporte técnico y mantener la seguridad y el buen funcionamiento del servicio.</Li>
          </ul>
          <p>No vendemos datos personales ni los usamos para publicidad. No usamos las conversaciones de los negocios para anunciar ni para crear perfiles comerciales.</p>
        </Section>

        <Section title="4. Con quién los compartimos">
          <p>Para operar usamos proveedores que tratan datos únicamente para prestarnos su servicio:</p>
          <ul>
            <Li><b>Meta</b> (WhatsApp, Messenger e Instagram): para recibir y enviar los mensajes.</Li>
            <Li><b>Proveedores de modelos de inteligencia artificial</b> (por medio de OpenRouter): reciben el contenido necesario de la conversación para generar la respuesta.</Li>
            <Li><b>Retell AI y proveedores de telefonía</b>: para contestar llamadas.</Li>
            <Li><b>Google</b> (Google Calendar), solo si el negocio decide conectarlo: para reflejar las citas confirmadas en su calendario.</Li>
            <Li><b>Mercado Pago</b>: para cobrar la suscripción.</Li>
            <Li><b>Railway</b>: infraestructura donde se aloja el servicio y su base de datos.</Li>
          </ul>
          <p>
            Algunos de estos proveedores están fuera de México; al usarlos, los datos pueden transferirse y tratarse en otros países. También podemos revelar datos cuando una autoridad competente lo
            exija conforme a la ley.
          </p>
        </Section>

        <Section title="5. Uso de la información de Google">
          <p>
            Si un negocio conecta Google Calendar, Tamia solicita únicamente permiso para crear y actualizar eventos de las citas confirmadas. Usamos esa información solo para ese fin: no la
            compartimos con terceros ni la usamos para publicidad. El uso y la transferencia de la información recibida de las API de Google cumple con la{" "}
            <a className="text-teal-800 underline" href="https://developers.google.com/terms/api-services-user-data-policy" rel="noopener noreferrer">Política de datos de usuario de los servicios de API de Google</a>,
            incluidos los requisitos de uso limitado. El negocio puede desconectar el calendario cuando quiera desde el panel.
          </p>
        </Section>

        <Section title="6. Uso de la información de Meta">
          <p>
            Cuando un negocio conecta su página de Facebook o su cuenta de Instagram, usamos los permisos que autoriza para recibir los mensajes que le escriben y enviar las respuestas. No
            publicamos nada en la página ni leemos información que no sea necesaria para esa conversación. El negocio puede desconectar el canal en cualquier momento.
          </p>
        </Section>

        <Section title="7. Cuánto tiempo los conservamos">
          <p>
            Conservamos la información mientras el negocio tenga una cuenta activa, porque la necesita para su historial de atención. Si cancela, o si nos lo pide, eliminamos o anonimizamos sus
            datos y los de sus conversaciones, salvo lo que debamos conservar por obligación legal o para resolver una controversia.
          </p>
        </Section>

        <Section title="8. Seguridad">
          <p>
            Usamos conexiones cifradas (HTTPS), guardamos cifrados los accesos a WhatsApp, Facebook, Instagram y Google, separamos los datos de cada negocio a nivel de base de datos y solo
            damos acceso a quien lo necesita. Ningún sistema es infalible; si ocurriera una vulneración que afecte tus datos, te lo haremos saber conforme a la ley.
          </p>
        </Section>

        <Section id="derechos" title="9. Tus derechos (ARCO)">
          <p>
            Conforme a la Ley Federal de Protección de Datos Personales en Posesión de los Particulares, puedes <b>acceder, rectificar, cancelar u oponerte</b> al tratamiento de tus datos, y revocar el
            consentimiento que nos hayas dado. Si eres paciente o cliente de un negocio que usa Tamia, también puedes pedírselo directamente al negocio.
          </p>
          <p>Para ejercer tus derechos escribe a {contact} indicando tu nombre, el negocio con el que hablaste y el número o cuenta desde el que lo hiciste. Respondemos en un máximo de 20 días hábiles.</p>
        </Section>

        <Section id="eliminar-datos" title="10. Cómo eliminar tus datos">
          <p>Puedes pedir que eliminemos tus datos de Tamia (por ejemplo, los de una conversación de Messenger, Instagram o WhatsApp) así:</p>
          <ol className="space-y-1">
            <li className="ml-5 list-decimal">Escribe a {contact} con el asunto «Eliminar mis datos».</li>
            <li className="ml-5 list-decimal">Indica el nombre del negocio y desde qué cuenta o número le escribiste.</li>
            <li className="ml-5 list-decimal">Confirmamos la solicitud y eliminamos los datos asociados a esa cuenta en un plazo máximo de 30 días, y te avisamos cuando esté hecho.</li>
          </ol>
          <p>Si eres un negocio, puedes desconectar tus canales y pedir la baja de tu cuenta y de todos sus datos por el mismo medio.</p>
        </Section>

        <Section title="11. Menores de edad">
          <p>Tamia es un servicio para negocios y no está dirigido a menores de edad. Si un menor se comunica con un negocio, el negocio es responsable de la atención.</p>
        </Section>

        <Section title="12. Cambios a este aviso">
          <p>Podemos actualizar este aviso. Publicaremos la versión vigente en esta página con su fecha de actualización, y avisaremos a los negocios si el cambio es importante.</p>
        </Section>

        <Section title="13. Contacto">
          <p>Dudas sobre este aviso o sobre tus datos: {contact}.</p>
        </Section>
      </article>
    </main>
  );
}
