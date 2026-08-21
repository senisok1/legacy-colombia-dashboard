// Welcome email sent to a new team member the moment their login is created
// (2026-08-17, Seni's ask: "make sure a nice email goes out to the new team
// member once their login is set up with instructions on how to login and
// simple and clear instructions on what each tab does and how to enter info
// and what info to enter").
//
// Deliberately written for a non-technical on-site reader (property manager,
// cleaner, host) — short sentences, one instruction per line, no jargon.
// Localized to the language chosen for that person in Settings → Add a Team
// Member, because that's the whole point of the language setting: they read
// and write notes in their own language and the system translates their
// notes to English for the admin.
//
// Sent through lib/email.ts (Resend). Best-effort: a failed send must never
// block or roll back the login creation itself — the API returns
// `emailSent: false` plus the reason so the admin can hand over the details
// manually.

export type WelcomeEmailInput = {
  name: string | null;
  email: string;
  /** null = don't print a password (2026-08-17). Used when onboarding a
   * login that ALREADY EXISTS: passwords are stored hashed and can't be read
   * back, and resetting one just to put it in an email would invalidate the
   * credentials the owner already handed over in person. The email instead
   * points them at the password they were given. */
  password: string | null;
  /** 'English' | 'Spanish' | 'Portuguese' — falls back to English. */
  language?: string;
  /** true when this login can see/do everything (CEO role). */
  isAdmin: boolean;
  /** true for a CONSTRUCTION login (2026-08-20) — sees ONLY the Construction
   * Management tab, nothing else. Mutually exclusive with isAdmin; checked
   * second so isAdmin still wins if both were ever true by mistake. */
  isConstruction?: boolean;
  /** Property names this login may see; empty = all properties. */
  properties: string[];
  loginUrl: string;
};

type Copy = {
  subject: string;
  hello: (name: string) => string;
  intro: string;
  yourLoginTitle: string;
  emailLabel: string;
  passwordLabel: string;
  openButton: string;
  changePwTitle: string;
  changePwBody: string;
  /** Shown in place of the password line for an existing login. */
  existingPasswordNote: string;
  propertiesTitle: string;
  allProperties: string;
  tabsTitle: string;
  tabs: { name: string; what: string; how: string }[];
  /** Owner/admin logins see every tab, so they get their own list and intro
   * (2026-08-17) — the team copy would understate what they can do. */
  adminIntro: string;
  adminTabs: { name: string; what: string; how: string }[];
  adminNotesTitle: string;
  adminNotesRules: string[];
  notesTitle: string;
  notesRules: string[];
  helpTitle: string;
  helpBody: string;
  footer: string;
  /** Construction Management login (2026-08-20) — sees exactly one tab, so
   * it gets its own tiny intro/tabs/notes/help rather than reusing the
   * property-management team copy above, which references tabs (Team
   * Management, Team Expense Request…) this login can never open. */
  constructionIntro: string;
  constructionTabs: { name: string; what: string; how: string }[];
  constructionNotesTitle: string;
  constructionNotesRules: string[];
  constructionHelpBody: string;
};

const COPY: Record<string, Copy> = {
  English: {
    subject: "Your Legacy Estate Rentals login — how to get started",
    hello: (n) => `Hi ${n},`,
    intro:
      "Your login for the Legacy Estate Rentals dashboard is ready. Everything the team needs to coordinate a stay lives here — arrivals, guest contact details, events, and notes.",
    yourLoginTitle: "Your login",
    emailLabel: "Email",
    passwordLabel: "Password",
    openButton: "Open the dashboard",
    changePwTitle: "Change your password",
    changePwBody:
      "Please change this password after your first sign-in. Go to Settings → My Account, type your current password and the new one, and press Save. Only you will know the new password.",
    existingPasswordNote:
      "Use the password Seni gave you. You can change it any time under Settings → My Account.",
    propertiesTitle: "Properties you can see",
    allProperties: "All properties",
    tabsTitle: "What each tab does",
    tabs: [
      {
        name: "Dashboard",
        what: "The quick picture: who is on the property right now, who arrives next, and a calendar of booked days.",
        how: "Nothing to fill in here — it updates itself. Hover any day on the calendar to see the guest's name.",
      },
      {
        name: "Team Management",
        what: "Your main tab. Every upcoming and in-house stay, with the guest's name, phone, email, dates, number of guests, and any event booked during the stay.",
        how: "This is where you write notes about a guest. See the next section.",
      },
      {
        name: "Team Expense Request",
        what: "Ask the owner to approve money for something the property needs.",
        how: "Press \"Request an expense\", say what it is, why it's needed, roughly what it costs and by when. The owner ticks it approved; once you've bought it, tick Completed and enter what it really cost.",
      },
      {
        name: "Team Activity Log",
        what: "Work that isn't tied to one guest — cleaning, repairs, deliveries, supplies.",
        how: "Type what you did and press \"Log it\". Your name and the time are saved automatically.",
      },
      {
        name: "Settings",
        what: "Your own account — who you're signed in as, which properties you can see.",
        how: "Open Settings to change your password whenever you want.",
      },
    ],
    adminIntro:
      "You've been set up as an owner on the Legacy Estate Rentals dashboard. Owner logins can see and change everything for the properties listed below — bookings, guest messaging, pricing, bills and the team.",
    adminTabs: [
      {
        name: "Dashboard",
        what: "Occupancy, arrivals, revenue and the booking calendar for your property.",
        how: "Hover any day on the calendar to see who's staying.",
      },
      {
        name: "Team Management",
        what: "Every upcoming and in-house stay with guest contact details, plus the events booked during a stay.",
        how: "Tick \"Event deposit paid & scheduled during stay\" and set the event date, time and headcount — those feed the Events list under the calendar.",
      },
      {
        name: "Team Expense Request",
        what: "What the on-site team is asking to spend money on.",
        how: "Tick \"Owner approved\" to release it — only owner logins can. Decline with a reason if not. The team marks it Completed with what it really cost.",
      },
      {
        name: "Team Activity Log",
        what: "Everything the team has done that isn't tied to one guest.",
        how: "Read-only for you in practice — the team writes here.",
      },
      {
        name: "Messaging",
        what: "Guest conversations, AI draft replies waiting for approval, and reviews.",
        how: "Nothing is ever sent to a guest without your approval.",
      },
      {
        name: "Marketing",
        what: "Content and social drafts, guest campaigns, and the sales pipeline.",
        how: "Draft here, approve, then publish.",
      },
      {
        name: "Reports",
        what: "Performance reports, AI Pricing (rate suggestions), and the AI activity log.",
        how: "AI Pricing suggests rate changes; you decide whether to apply them.",
      },
      {
        name: "Bill Pay",
        what: "Monthly recurring bills and invoice tracking.",
        how: "Add each bill you pay every month, then tick it off. Anything unpaid rolls into the next month flagged as carried over.",
      },
      {
        name: "Settings",
        what: "Appearance, currency, your own password, team logins and billing.",
        how: "Settings → Add a Team Member creates logins and sets which properties each person can see.",
      },
    ],
    adminNotesTitle: "A few things worth knowing",
    adminNotesRules: [
      "You only see the properties listed above. Use the property name at the top-left to switch between them.",
      "Team-member logins see only Dashboard, Team Management, Team Expense Request, Team Activity Log and Settings — they can't message guests or change bookings.",
      "Expense approvals are owner-only. If a team member edits a request after you approved it, it comes back to you for re-approval.",
      "Change your password any time under Settings → My Account.",
    ],
    notesTitle: "How to add information (Team Management tab)",
    notesRules: [
      "Notes on a guest — click the note box under that guest's name, type what happened, and press Add. Your name and the time are saved automatically, so the whole team knows who wrote it.",
      "Write anything the next person needs to know: early check-in, late checkout, extra guests, damage, maintenance needed, special requests, or anything the guest asked for.",
      "Team Activity Log tab — use it for work that isn't tied to one guest (cleaning done, repairs, deliveries, supplies bought).",
      "Be specific and short. \"Pool pump replaced, receipt with Gabriel\" is better than \"fixed pool\".",
    ],
    helpTitle: "One thing to remember",
    helpBody:
      "You can view everything, but you cannot message guests or change bookings — only the owner can. If something needs a reply to a guest, add a note and tell the owner.",
    footer: "Legacy Estate Rentals",
    constructionIntro:
      "Your login is ready! You can see 3 tabs: Dashboard, Construction Management, and Construction Budget.",
    constructionTabs: [
      {
        name: "Dashboard",
        what: "A quick look at the property — who is staying there now, and who is coming next so you can see when guests will be on the property.",
        how: "You don't type anything here. It updates by itself.",
      },
      {
        name: "Construction Management",
        what: "A to-do list for the property. Anyone on the team can add a job and check it off when it's done. Please add the estimated time of completion as well as the cost (if it's not covered warranty work) so that everyone can track.",
        how: "Type the job and press Add. When it's finished, click the checkbox next to it. Your name and the time are saved so everyone can see who did it.",
      },
      {
        name: "Construction Budget",
        what: "The money plan for the project, and what has really been spent so far.",
        how: "Find the item you worked on. Type how much it really cost in the box called Actual (COP). You can also click Notes to write more about it.",
      },
    ],
    constructionNotesTitle: "How to use it",
    constructionNotesRules: [
      "Add a job for anything that needs to happen — a repair, a delivery, materials you need.",
      "Say exactly what it is. \"Fix the broken tile in the 2nd floor bathroom\" is better than \"fix tile.\"",
      "Only check a job as done when it is really done — not before.",
      "In Construction Budget, type the real cost after you spend the money, not before.",
      "You can always scroll down to see what everyone else has done. That list is called the activity log.",
    ],
    constructionHelpBody:
      "You can only see these 3 tabs: Dashboard, Construction Management, and Construction Budget. Nothing else on the dashboard is visible to you. If you have any questions, contact Seni (senisok1@gmail.com).",
  },

  Spanish: {
    subject: "Tu acceso a Legacy Estate Rentals — cómo empezar",
    hello: (n) => `Hola ${n}:`,
    intro:
      "Tu acceso al panel de Legacy Estate Rentals ya está listo. Aquí está todo lo que el equipo necesita para coordinar una estadía: llegadas, datos de contacto del huésped, eventos y notas.",
    yourLoginTitle: "Tus datos de acceso",
    emailLabel: "Correo",
    passwordLabel: "Contraseña",
    openButton: "Abrir el panel",
    changePwTitle: "Cambia tu contraseña",
    changePwBody:
      "Por favor cambia esta contraseña después de entrar por primera vez. Ve a Configuración → Mi cuenta, escribe tu contraseña actual y la nueva, y presiona Guardar. Solo tú conocerás la nueva contraseña.",
    existingPasswordNote:
      "Usa la contraseña que te dio Seni. Puedes cambiarla cuando quieras en Settings → My Account.",
    propertiesTitle: "Propiedades que puedes ver",
    allProperties: "Todas las propiedades",
    tabsTitle: "Para qué sirve cada pestaña",
    tabs: [
      {
        name: "Dashboard (Panel)",
        what: "La vista rápida: quién está en la propiedad ahora, quién llega después y un calendario de los días reservados.",
        how: "No hay nada que llenar aquí, se actualiza solo. Pasa el mouse por cualquier día del calendario para ver el nombre del huésped.",
      },
      {
        name: "Team Management (Gestión)",
        what: "Tu pestaña principal. Todas las estadías próximas y en curso, con el nombre del huésped, teléfono, correo, fechas, número de huéspedes y cualquier evento reservado durante la estadía.",
        how: "Aquí escribes las notas sobre el huésped. Mira la siguiente sección.",
      },
      {
        name: "Team Expense Request (Solicitud de gasto)",
        what: "Pide al dueño que apruebe dinero para algo que la propiedad necesita.",
        how: "Presiona \"Request an expense\", escribe qué es, por qué se necesita, cuánto cuesta más o menos y para cuándo. El dueño lo aprueba; cuando ya lo compraste, marca Completed y escribe lo que costó de verdad.",
      },
      {
        name: "Team Activity Log (Registro del equipo)",
        what: "Trabajo que no es de un huésped específico: limpieza, reparaciones, entregas, insumos.",
        how: "Escribe lo que hiciste y presiona \"Log it\". Tu nombre y la hora se guardan solos.",
      },
      {
        name: "Settings (Configuración)",
        what: "Tu propia cuenta: con qué usuario entraste y qué propiedades puedes ver.",
        how: "Entra a Settings para cambiar tu contraseña cuando quieras.",
      },
    ],
    adminIntro:
      "Te configuramos como propietario en el panel de Legacy Estate Rentals. Los accesos de propietario pueden ver y cambiar todo en las propiedades listadas abajo: reservas, mensajes con huéspedes, precios, cuentas y el equipo.",
    adminTabs: [
      {
        name: "Dashboard (Panel)",
        what: "Ocupación, llegadas, ingresos y el calendario de reservas de tu propiedad.",
        how: "Pasa el mouse por cualquier día del calendario para ver quién se queda.",
      },
      {
        name: "Team Management (Gestión)",
        what: "Todas las estadías próximas y en curso con los datos del huésped, más los eventos agendados durante la estadía.",
        how: "Marca \"Event deposit paid & scheduled during stay\" y define fecha, hora y número de asistentes — eso alimenta la lista de eventos.",
      },
      {
        name: "Team Expense Request (Solicitud de gasto)",
        what: "Lo que el equipo pide gastar.",
        how: "Marca \"Owner approved\" para autorizarlo — solo los propietarios pueden. El equipo lo marca Completed con lo que costó de verdad.",
      },
      {
        name: "Team Activity Log (Registro del equipo)",
        what: "Todo lo que hizo el equipo que no corresponde a un huésped específico.",
        how: "En la práctica es de solo lectura para ti — el equipo escribe ahí.",
      },
      {
        name: "Messaging",
        what: "Conversaciones con huéspedes, borradores de IA esperando aprobación y reseñas.",
        how: "Nunca se envía nada a un huésped sin tu aprobación.",
      },
      {
        name: "Marketing",
        what: "Contenido y borradores sociales, campañas a huéspedes y el pipeline de ventas.",
        how: "Redacta, aprueba y publica.",
      },
      {
        name: "Reports",
        what: "Reportes de desempeño, AI Pricing (sugerencias de tarifas) y el registro de actividad de la IA.",
        how: "AI Pricing sugiere cambios de tarifa; tú decides si aplicarlos.",
      },
      {
        name: "Bill Pay",
        what: "Cuentas mensuales recurrentes y seguimiento de facturas.",
        how: "Agrega cada cuenta mensual y márcala cuando la pagues. Lo que quede sin pagar pasa al mes siguiente marcado como pendiente.",
      },
      {
        name: "Settings",
        what: "Apariencia, moneda, tu contraseña, accesos del equipo y facturación.",
        how: "Settings → Add a Team Member crea accesos y define qué propiedades ve cada persona.",
      },
    ],
    adminNotesTitle: "Algunas cosas importantes",
    adminNotesRules: [
      "Solo ves las propiedades listadas arriba. Usa el nombre de la propiedad arriba a la izquierda para cambiar entre ellas.",
      "Los accesos de equipo solo ven Dashboard, Team Management, Team Expense Request, Team Activity Log y Settings — no pueden escribirle a los huéspedes ni cambiar reservas.",
      "Las aprobaciones de gastos son solo del propietario. Si alguien edita una solicitud ya aprobada, vuelve a ti para aprobarla de nuevo.",
      "Cambia tu contraseña cuando quieras en Settings → My Account.",
    ],
    notesTitle: "Cómo agregar información (pestaña Team Management)",
    notesRules: [
      "Notas de un huésped: haz clic en el cuadro de notas debajo del nombre del huésped, escribe lo que pasó y presiona Agregar. Tu nombre y la hora se guardan solos, para que todo el equipo sepa quién lo escribió.",
      "Escribe todo lo que la siguiente persona necesite saber: entrada anticipada, salida tardía, huéspedes adicionales, daños, mantenimiento necesario, pedidos especiales o cualquier cosa que haya pedido el huésped.",
      "Pestaña Team Activity Log: úsala para el trabajo que no es de un huésped específico (limpieza hecha, reparaciones, entregas, compras de insumos).",
      "Sé breve y específico. \"Cambiada la bomba de la piscina, factura con Gabriel\" es mejor que \"arreglé la piscina\".",
    ],
    helpTitle: "Algo importante",
    helpBody:
      "Puedes ver todo, pero no puedes escribirle a los huéspedes ni cambiar reservas: eso solo lo hace el dueño. Si algo necesita respuesta al huésped, escribe una nota y avísale al dueño.",
    footer: "Legacy Estate Rentals",
    constructionIntro:
      "¡Tu acceso ya está listo! Puedes ver 3 pestañas: Dashboard, Construction Management y Construction Budget.",
    constructionTabs: [
      {
        name: "Dashboard",
        what: "Una vista rápida de la propiedad: quién está ahí ahora y quién llega después, así puedes ver cuándo habrá huéspedes en la propiedad.",
        how: "No tienes que escribir nada aquí. Se actualiza solo.",
      },
      {
        name: "Construction Management",
        what: "Una lista de tareas de la propiedad. Cualquiera del equipo puede agregar una tarea y marcarla como hecha. Por favor agrega la fecha estimada de finalización y el costo (si no es un trabajo cubierto por garantía) para que todos puedan hacer seguimiento.",
        how: "Escribe la tarea y presiona Add. Cuando esté lista, marca la casilla junto a ella. Tu nombre y la hora quedan guardados para que todos vean quién la hizo.",
      },
      {
        name: "Construction Budget",
        what: "El plan de gastos del proyecto, y lo que realmente se ha gastado hasta ahora.",
        how: "Busca el ítem en el que trabajaste. Escribe cuánto costó de verdad en la casilla Actual (COP). También puedes hacer clic en Notes para escribir más detalles.",
      },
    ],
    constructionNotesTitle: "Cómo usarla",
    constructionNotesRules: [
      "Agrega una tarea por cada cosa que haga falta: una reparación, una entrega, materiales que necesitas.",
      "Sé bien específico. \"Cambiar la baldosa rota del baño del segundo piso\" es mejor que \"arreglar baldosa\".",
      "Marca una tarea como hecha solo cuando ya esté terminada de verdad, no antes.",
      "En Construction Budget, escribe el costo real después de gastar el dinero, no antes.",
      "Siempre puedes bajar para ver lo que ha hecho el resto del equipo. Esa lista se llama el registro de actividad.",
    ],
    constructionHelpBody:
      "Solo puedes ver estas 3 pestañas: Dashboard, Construction Management y Construction Budget. Nada más del panel es visible para ti. Si tienes alguna pregunta, contacta a Seni (senisok1@gmail.com).",
  },

  Portuguese: {
    subject: "Seu acesso à Legacy Estate Rentals — como começar",
    hello: (n) => `Olá ${n},`,
    intro:
      "Seu acesso ao painel da Legacy Estate Rentals está pronto. Aqui está tudo o que a equipe precisa para coordenar uma estadia: chegadas, contatos do hóspede, eventos e anotações.",
    yourLoginTitle: "Seus dados de acesso",
    emailLabel: "E-mail",
    passwordLabel: "Senha",
    openButton: "Abrir o painel",
    changePwTitle: "Troque sua senha",
    changePwBody:
      "Por favor, troque esta senha depois do primeiro acesso. Vá em Settings → My Account (Minha conta), digite a senha atual e a nova, e clique em Salvar. Só você saberá a nova senha.",
    existingPasswordNote:
      "Use a senha que o Seni te passou. Você pode trocá-la quando quiser em Settings → My Account.",
    propertiesTitle: "Propriedades que você pode ver",
    allProperties: "Todas as propriedades",
    tabsTitle: "O que cada aba faz",
    tabs: [
      {
        name: "Dashboard (Painel)",
        what: "A visão rápida: quem está na propriedade agora, quem chega em seguida e um calendário dos dias reservados.",
        how: "Não há nada para preencher aqui, atualiza sozinho. Passe o mouse sobre qualquer dia do calendário para ver o nome do hóspede.",
      },
      {
        name: "Team Management (Gestão)",
        what: "Sua aba principal. Todas as estadias futuras e em andamento, com nome do hóspede, telefone, e-mail, datas, número de hóspedes e qualquer evento marcado durante a estadia.",
        how: "É aqui que você escreve as anotações sobre o hóspede. Veja a próxima seção.",
      },
      {
        name: "Team Expense Request (Pedido de despesa)",
        what: "Peça ao proprietário para aprovar dinheiro para algo que a propriedade precisa.",
        how: "Clique em \"Request an expense\", escreva o que é, por que precisa, quanto custa aproximadamente e para quando. O proprietário aprova; depois de comprar, marque Completed e escreva quanto custou de verdade.",
      },
      {
        name: "Team Activity Log (Registro da equipe)",
        what: "Trabalhos que não são de um hóspede específico: limpeza, consertos, entregas, materiais.",
        how: "Escreva o que você fez e clique em \"Log it\". Seu nome e o horário são salvos automaticamente.",
      },
      {
        name: "Settings (Configurações)",
        what: "Sua própria conta: com qual usuário você entrou e quais propriedades pode ver.",
        how: "Abra Settings para trocar sua senha quando quiser.",
      },
    ],
    adminIntro:
      "Você foi configurado como proprietário no painel da Legacy Estate Rentals. Acessos de proprietário podem ver e alterar tudo nas propriedades listadas abaixo: reservas, mensagens com hóspedes, preços, contas e a equipe.",
    adminTabs: [
      {
        name: "Dashboard (Painel)",
        what: "Ocupação, chegadas, receita e o calendário de reservas da sua propriedade.",
        how: "Passe o mouse sobre qualquer dia do calendário para ver quem está hospedado.",
      },
      {
        name: "Team Management (Gestão)",
        what: "Todas as estadias futuras e em andamento com os contatos do hóspede, além dos eventos marcados durante a estadia.",
        how: "Marque \"Event deposit paid & scheduled during stay\" e defina data, horário e número de pessoas — isso alimenta a lista de eventos.",
      },
      {
        name: "Team Expense Request (Pedido de despesa)",
        what: "O que a equipe está pedindo para gastar.",
        how: "Marque \"Owner approved\" para autorizar — só proprietários podem. A equipe marca Completed com o valor real.",
      },
      {
        name: "Team Activity Log (Registro da equipe)",
        what: "Tudo o que a equipe fez que não é de um hóspede específico.",
        how: "Na prática é somente leitura para você — a equipe escreve ali.",
      },
      {
        name: "Messaging",
        what: "Conversas com hóspedes, rascunhos de IA aguardando aprovação e avaliações.",
        how: "Nada é enviado a um hóspede sem a sua aprovação.",
      },
      {
        name: "Marketing",
        what: "Conteúdo e rascunhos sociais, campanhas para hóspedes e o funil de vendas.",
        how: "Escreva, aprove e publique.",
      },
      {
        name: "Reports",
        what: "Relatórios de desempenho, AI Pricing (sugestões de tarifa) e o registro de atividade da IA.",
        how: "O AI Pricing sugere mudanças de tarifa; você decide se aplica.",
      },
      {
        name: "Bill Pay",
        what: "Contas mensais recorrentes e acompanhamento de faturas.",
        how: "Cadastre cada conta mensal e marque quando pagar. O que ficar em aberto passa para o mês seguinte sinalizado como pendente.",
      },
      {
        name: "Settings",
        what: "Aparência, moeda, sua senha, acessos da equipe e faturamento.",
        how: "Settings → Add a Team Member cria acessos e define quais propriedades cada pessoa vê.",
      },
    ],
    adminNotesTitle: "Alguns pontos importantes",
    adminNotesRules: [
      "Você só vê as propriedades listadas acima. Use o nome da propriedade no canto superior esquerdo para alternar.",
      "Acessos de equipe veem apenas Dashboard, Team Management, Team Expense Request, Team Activity Log e Settings — não podem enviar mensagens a hóspedes nem alterar reservas.",
      "Aprovações de despesa são exclusivas do proprietário. Se alguém editar um pedido já aprovado, ele volta para sua aprovação.",
      "Troque sua senha quando quiser em Settings → My Account.",
    ],
    notesTitle: "Como registrar informações (aba Team Management)",
    notesRules: [
      "Anotações de um hóspede: clique na caixa de anotação abaixo do nome do hóspede, escreva o que aconteceu e clique em Adicionar. Seu nome e o horário são salvos automaticamente, então toda a equipe sabe quem escreveu.",
      "Escreva tudo o que a próxima pessoa precisa saber: check-in antecipado, check-out tardio, hóspedes extras, danos, manutenção necessária, pedidos especiais ou qualquer coisa que o hóspede pediu.",
      "Aba Team Activity Log: use para trabalhos que não são de um hóspede específico (limpeza feita, consertos, entregas, compras de materiais).",
      "Seja curto e específico. \"Bomba da piscina trocada, recibo com o Gabriel\" é melhor que \"consertei a piscina\".",
    ],
    helpTitle: "Um ponto importante",
    helpBody:
      "Você pode ver tudo, mas não pode enviar mensagens aos hóspedes nem alterar reservas — só o proprietário pode. Se algo precisar de resposta ao hóspede, escreva uma anotação e avise o proprietário.",
    footer: "Legacy Estate Rentals",
    constructionIntro:
      "Seu acesso já está pronto! Você pode ver 3 abas: Dashboard, Construction Management e Construction Budget.",
    constructionTabs: [
      {
        name: "Dashboard",
        what: "Uma visão rápida da propriedade: quem está lá agora e quem chega a seguir, assim você pode ver quando haverá hóspedes na propriedade.",
        how: "Você não precisa digitar nada aqui. Ele se atualiza sozinho.",
      },
      {
        name: "Construction Management",
        what: "Uma lista de tarefas da propriedade. Qualquer pessoa da equipe pode adicionar uma tarefa e marcá-la como concluída. Por favor, adicione a data estimada de conclusão e o custo (se não for um trabalho coberto por garantia) para que todos possam acompanhar.",
        how: "Escreva a tarefa e clique em Add. Quando terminar, marque a caixinha ao lado dela. Seu nome e o horário ficam salvos para todos verem quem fez.",
      },
      {
        name: "Construction Budget",
        what: "O plano de gastos do projeto, e o que já foi realmente gasto até agora.",
        how: "Encontre o item em que você trabalhou. Digite quanto custou de verdade na caixa Actual (COP). Você também pode clicar em Notes para escrever mais detalhes.",
      },
    ],
    constructionNotesTitle: "Como usar",
    constructionNotesRules: [
      "Adicione uma tarefa para tudo que precisar ser feito: um reparo, uma entrega, materiais necessários.",
      "Seja bem específico. \"Trocar o azulejo quebrado do banheiro do 2º andar\" é melhor que \"consertar azulejo\".",
      "Marque uma tarefa como concluída só quando ela realmente estiver pronta, não antes.",
      "Em Construction Budget, digite o custo real depois de gastar o dinheiro, não antes.",
      "Você sempre pode rolar para baixo e ver o que o resto da equipe fez. Essa lista se chama registro de atividade.",
    ],
    constructionHelpBody:
      "Você só pode ver estas 3 abas: Dashboard, Construction Management e Construction Budget. Mais nada do painel é visível para você. Se tiver alguma dúvida, entre em contato com o Seni (senisok1@gmail.com).",
  },
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildWelcomeEmail(input: WelcomeEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const c = COPY[input.language ?? "English"] ?? COPY.English;
  const name = input.name?.trim() || input.email.split("@")[0];
  const properties = input.properties.length > 0 ? input.properties.join(", ") : c.allProperties;

  const tabs = input.isAdmin ? c.adminTabs : input.isConstruction ? c.constructionTabs : c.tabs;
  const intro = input.isAdmin ? c.adminIntro : input.isConstruction ? c.constructionIntro : c.intro;
  const notesTitle = input.isAdmin ? c.adminNotesTitle : input.isConstruction ? c.constructionNotesTitle : c.notesTitle;
  const notesRules = input.isAdmin ? c.adminNotesRules : input.isConstruction ? c.constructionNotesRules : c.notesRules;
  const helpBody = input.isConstruction ? c.constructionHelpBody : c.helpBody;
  // Admin logins skip the "one thing to remember" callout entirely (see the
  // isAdmin ternary further down) since it doesn't apply to them; a
  // construction login gets its own version of that callout via helpBody
  // above.

  const subject = input.isAdmin
    ? c.subject.replace("login", "owner login")
    : c.subject;

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f4;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1917;line-height:1.55;">
    <div style="background:#0a0a0a;color:#ffffff;border-radius:12px 12px 0 0;padding:20px 24px;">
      <div style="font-size:18px;font-weight:600;letter-spacing:0.02em;">Legacy Estate Rentals</div>
      <div style="font-size:13px;opacity:0.7;">Team dashboard</div>
    </div>

    <div style="background:#ffffff;border-radius:0 0 12px 12px;padding:24px;">
      <p style="margin:0 0 12px;font-size:16px;font-weight:600;">${esc(c.hello(name))}</p>
      <p style="margin:0 0 20px;font-size:15px;">${esc(intro)}</p>

      <div style="border:1px solid #e7e5e4;border-radius:10px;padding:16px;background:#fafaf9;margin-bottom:20px;">
        <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#78716c;margin-bottom:10px;">${esc(
          c.yourLoginTitle
        )}</div>
        <div style="font-size:15px;margin-bottom:4px;"><strong>${esc(c.emailLabel)}:</strong> ${esc(
          input.email
        )}</div>
        ${
          input.password
            ? `<div style="font-size:15px;"><strong>${esc(c.passwordLabel)}:</strong> <code style="background:#f0efee;padding:2px 6px;border-radius:4px;font-size:15px;">${esc(
                input.password
              )}</code></div>`
            : `<div style="font-size:15px;color:#44403c;">${esc(c.existingPasswordNote)}</div>`
        }
        <div style="margin-top:16px;">
          <a href="${esc(input.loginUrl)}" style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:15px;font-weight:600;">${esc(
            c.openButton
          )}</a>
        </div>
        <div style="margin-top:10px;font-size:13px;color:#78716c;">${esc(input.loginUrl)}</div>
      </div>

      <div style="margin-bottom:20px;">
        <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#78716c;margin-bottom:6px;">${esc(
          c.propertiesTitle
        )}</div>
        <div style="font-size:15px;">${esc(properties)}</div>
      </div>

      <div style="margin-bottom:20px;">
        <div style="font-size:16px;font-weight:600;margin-bottom:10px;">${esc(c.tabsTitle)}</div>
        ${tabs
          .map(
            (t) => `<div style="margin-bottom:12px;">
              <div style="font-size:15px;font-weight:600;">${esc(t.name)}</div>
              <div style="font-size:14px;color:#44403c;">${esc(t.what)}</div>
              <div style="font-size:14px;color:#78716c;">${esc(t.how)}</div>
            </div>`
          )
          .join("")}
      </div>

      <div style="margin-bottom:20px;">
        <div style="font-size:16px;font-weight:600;margin-bottom:10px;">${esc(notesTitle)}</div>
        <ul style="margin:0;padding-left:20px;font-size:14px;color:#44403c;">
          ${notesRules.map((r) => `<li style="margin-bottom:8px;">${esc(r)}</li>`).join("")}
        </ul>
      </div>

      ${
        input.isAdmin
          ? ""
          : `<div style="border:1px solid #e7e5e4;border-radius:10px;padding:14px 16px;background:#fafaf9;">
              <div style="font-size:15px;font-weight:600;margin-bottom:4px;">${esc(c.helpTitle)}</div>
              <div style="font-size:14px;color:#44403c;">${esc(helpBody)}</div>
            </div>`
      }

      <p style="margin:24px 0 0;font-size:13px;color:#a8a29e;">${esc(c.footer)}</p>
    </div>
  </div>
</body></html>`;

  const text = [
    c.hello(name),
    "",
    intro,
    "",
    `${c.yourLoginTitle}:`,
    `  ${c.emailLabel}: ${input.email}`,
    input.password ? `  ${c.passwordLabel}: ${input.password}` : `  ${c.existingPasswordNote}`,
    `  ${input.loginUrl}`,
    "",
    `${c.propertiesTitle}: ${properties}`,
    "",
    `${c.tabsTitle}:`,
    ...tabs.map((t) => `  - ${t.name}: ${t.what} ${t.how}`),
    "",
    `${notesTitle}:`,
    ...notesRules.map((r) => `  - ${r}`),
    ...(input.isAdmin ? [] : ["", `${c.helpTitle}: ${helpBody}`]),
    "",
    c.footer,
  ].join("\n");

  return { subject, html, text };
}
