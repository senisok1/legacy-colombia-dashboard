// CRM interface localization (2026-08-19, Seni's ask: "change his interface
// to spanish and give the admin/owner the option to change the interface to
// English/Spanish/Portugese when adding a new team member"). Reuses the
// SAME `language` field team logins already had (Settings → Add a Team
// Member) — that field already drove translated WhatsApp/email notification
// text (see lib/translate.ts, api/whatsapp/webhook/route.ts); it just never
// touched the dashboard's own UI chrome until now.
//
// Scope: every screen a READ_ONLY team login (e.g. Gabriel) can actually
// reach — NavBar, Dashboard, Team Management (board/calendar/events/
// transactions/countdown), Team Expense Request, Team Activity Log + Team
// Requests, and the restricted Settings/My Account view. Admin-only tabs
// (Messaging, Marketing, Reports, Bill Pay, full Settings, CRM, etc.) stay
// English-only for now — every admin login today has language:"English",
// and translating screens nobody who needs another language can even reach
// wasn't worth the surface area.
//
// Static UI chrome only (labels, buttons, headings, placeholders, badges).
// Dynamic content stays as-is by design: guest names, property names,
// booking statuses/sources from OwnerRez, and error messages returned live
// from API routes are not translated — retranslating server error text would
// mean threading `lang` through dozens of API routes for messages Seni (the
// only English-only... well, everyone but Gabriel today) never needs
// translated anyway. statusLabel()/categoryLabel() below are the two
// exceptions: fixed, small enum-like value sets where a lookup table is
// cheap and worth it.
export type Lang = "English" | "Spanish" | "Portuguese";

export function normalizeLang(lang?: string | null): Lang {
  if (lang === "Spanish" || lang === "Portuguese") return lang;
  return "English";
}

type Entry = { English: string; Spanish: string; Portuguese: string };
type Dict = Record<string, Entry>;

const STRINGS: Dict = {
  // ---------- NavBar ----------
  "nav.dashboard": { English: "Dashboard", Spanish: "Panel", Portuguese: "Painel" },
  "nav.management": { English: "Team Management", Spanish: "Gestión del Equipo", Portuguese: "Gestão da Equipe" },
  "nav.expenses": { English: "Team Expense Request", Spanish: "Solicitud de Gastos", Portuguese: "Solicitação de Despesas" },
  "nav.activityLog": { English: "Team Activity Log", Spanish: "Registro de Actividad", Portuguese: "Registro de Atividades" },
  "nav.commissions": { English: "Commissions", Spanish: "Comisiones", Portuguese: "Comissões" },
  "nav.settings": { English: "Settings", Spanish: "Configuración", Portuguese: "Configurações" },
  "nav.logout": { English: "Log out", Spanish: "Cerrar sesión", Portuguese: "Sair" },
  "nav.switching": { English: "Switching…", Spanish: "Cambiando…", Portuguese: "Trocando…" },

  // ---------- Common ----------
  "common.loading": { English: "Loading…", Spanish: "Cargando…", Portuguese: "Carregando…" },
  "common.saving": { English: "Saving…", Spanish: "Guardando…", Portuguese: "Salvando…" },
  "common.save": { English: "Save", Spanish: "Guardar", Portuguese: "Salvar" },
  "common.cancel": { English: "Cancel", Spanish: "Cancelar", Portuguese: "Cancelar" },
  "common.edit": { English: "Edit", Spanish: "Editar", Portuguese: "Editar" },
  "common.delete": { English: "Delete", Spanish: "Eliminar", Portuguese: "Excluir" },
  "common.deleting": { English: "Deleting…", Spanish: "Eliminando…", Portuguese: "Excluindo…" },
  "common.remove": { English: "Remove", Spanish: "Quitar", Portuguese: "Remover" },
  "common.add": { English: "Add", Spanish: "Agregar", Portuguese: "Adicionar" },
  "common.post": { English: "Post", Spanish: "Publicar", Portuguese: "Publicar" },
  "common.posting": { English: "Posting…", Spanish: "Publicando…", Portuguese: "Publicando…" },
  "common.booked": { English: "Booked", Spanish: "Reservado", Portuguese: "Reservado" },
  "common.available": { English: "Available", Spanish: "Disponible", Portuguese: "Disponível" },
  "common.hoverDay": {
    English: "Hover a day to see who's at the house.",
    Spanish: "Pasa el cursor sobre un día para ver quién está en la casa.",
    Portuguese: "Passe o cursor sobre um dia para ver quem está na casa.",
  },
  "common.backToToday": { English: "Back to today", Spanish: "Volver a hoy", Portuguese: "Voltar para hoje" },

  // ---------- Dashboard ----------
  "dash.title": { English: "Dashboard", Spanish: "Panel", Portuguese: "Painel" },
  "dash.subtitle": {
    English: "Live snapshot of bookings, occupancy, and revenue for",
    Spanish: "Panorama en vivo de reservas, ocupación e ingresos de",
    Portuguese: "Panorama ao vivo de reservas, ocupação e receita de",
  },
  "dash.occupancy90d": { English: "Occupancy (90d)", Spanish: "Ocupación (90d)", Portuguese: "Ocupação (90d)" },
  "dash.occupancyHint": {
    English: "Booked nights / available nights",
    Spanish: "Noches reservadas / noches disponibles",
    Portuguese: "Noites reservadas / noites disponíveis",
  },
  "dash.avgLengthOfStay": { English: "Avg length of stay", Spanish: "Estadía promedio", Portuguese: "Estadia média" },
  "dash.yearToDate": { English: "Year to date", Spanish: "Año hasta la fecha", Portuguese: "Ano até a data" },
  "dash.currentlyCheckedIn": { English: "Currently checked in", Spanish: "Actualmente hospedados", Portuguese: "Atualmente hospedados" },
  "dash.upcomingArrivals": { English: "Upcoming arrivals", Spanish: "Próximas llegadas", Portuguese: "Próximas chegadas" },
  "dash.noGuestsOnProperty": {
    English: "No guests on-property right now.",
    Spanish: "No hay huéspedes en la propiedad en este momento.",
    Portuguese: "Nenhum hóspede na propriedade no momento.",
  },
  "dash.noUpcomingArrivals": { English: "No upcoming arrivals.", Spanish: "No hay próximas llegadas.", Portuguese: "Nenhuma chegada futura." },
  "dash.loadMore": { English: "Load more", Spanish: "Cargar más", Portuguese: "Carregar mais" },
  "dash.more": { English: "more", Spanish: "más", Portuguese: "mais" },

  // ---------- Bookings table ----------
  "table.guest": { English: "Guest", Spanish: "Huésped", Portuguese: "Hóspede" },
  "table.arrival": { English: "Arrival", Spanish: "Llegada", Portuguese: "Chegada" },
  "table.departure": { English: "Departure", Spanish: "Salida", Portuguese: "Saída" },
  "table.nights": { English: "Nights", Spanish: "Noches", Portuguese: "Noites" },
  "table.source": { English: "Source", Spanish: "Origen", Portuguese: "Origem" },
  "table.status": { English: "Status", Spanish: "Estado", Portuguese: "Status" },
  "table.total": { English: "Total", Spanish: "Total", Portuguese: "Total" },
  "table.noBookings": { English: "No bookings to show.", Spanish: "No hay reservas para mostrar.", Portuguese: "Nenhuma reserva para mostrar." },

  // ---------- Booking status labels (display only) ----------
  "status.Booked": { English: "Booked", Spanish: "Reservado", Portuguese: "Reservado" },
  "status.Checked In": { English: "Checked In", Spanish: "Registrado", Portuguese: "Check-in feito" },
  "status.Checked Out": { English: "Checked Out", Spanish: "Salió", Portuguese: "Check-out feito" },
  "status.Cancelled": { English: "Cancelled", Spanish: "Cancelado", Portuguese: "Cancelado" },
  "status.Hold": { English: "Hold", Spanish: "En espera", Portuguese: "Em espera" },
  "status.Quote": { English: "Quote", Spanish: "Cotización", Portuguese: "Orçamento" },
  "status.Inquiry": { English: "Inquiry", Spanish: "Consulta", Portuguese: "Consulta" },
  "status.Unknown": { English: "Unknown", Spanish: "Desconocido", Portuguese: "Desconhecido" },

  // ---------- Occupancy / stay calendar (shared wording) ----------
  "cal.occupancyMtd": { English: "Occupancy MTD", Spanish: "Ocupación del mes", Portuguese: "Ocupação do mês" },
  "cal.revenueMtd": { English: "Revenue MTD", Spanish: "Ingresos del mes", Portuguese: "Receita do mês" },
  "cal.avgNightlyRate": { English: "Avg nightly rate", Spanish: "Tarifa nocturna prom.", Portuguese: "Diária média" },
  "cal.net": { English: "Net", Spanish: "Neto", Portuguese: "Líquido" },
  "cal.eventDay": { English: "Event day", Spanish: "Día de evento", Portuguese: "Dia de evento" },
  "cal.previousMonth": { English: "Previous month", Spanish: "Mes anterior", Portuguese: "Mês anterior" },
  "cal.nextMonth": { English: "Next month", Spanish: "Mes siguiente", Portuguese: "Próximo mês" },

  // ---------- Team Management (page + board) ----------
  "mgmt.title": { English: "Team Management", Spanish: "Gestión del Equipo", Portuguese: "Gestão da Equipe" },
  "mgmt.subtitle": {
    English:
      "Upcoming and in-house stays for the on-site team — guest info, dates, party size, paid-extras requests, event notes, and the shared team activity log.",
    Spanish:
      "Estadías próximas y en curso para el equipo en sitio — datos del huésped, fechas, tamaño del grupo, solicitudes de extras pagos, notas de eventos, y el registro de actividad compartido.",
    Portuguese:
      "Estadias futuras e em andamento para a equipe no local — dados do hóspede, datas, tamanho do grupo, solicitações de extras pagos, notas de eventos e o registro de atividades compartilhado.",
  },
  "mgmt.loadingStays": { English: "Loading stays…", Spanish: "Cargando estadías…", Portuguese: "Carregando estadias…" },
  "mgmt.upcomingInHouse": { English: "Upcoming & in-house stays", Spanish: "Estadías próximas y en curso", Portuguese: "Estadias futuras e em andamento" },
  "mgmt.noUpcomingStays": {
    English: "No upcoming stays on the calendar.",
    Spanish: "No hay estadías próximas en el calendario.",
    Portuguese: "Nenhuma estadia futura no calendário.",
  },
  "mgmt.paidExtrasRequested": { English: "Paid extras requested", Spanish: "Extras pagos solicitados", Portuguese: "Extras pagos solicitados" },
  "mgmt.phoneProxy": { English: "📞 Proxy (via platform)", Spanish: "📞 Proxy (vía plataforma)", Portuguese: "📞 Proxy (via plataforma)" },
  "mgmt.emailProxy": { English: "✉️ Proxy (via platform)", Spanish: "✉️ Proxy (vía plataforma)", Portuguese: "✉️ Proxy (via plataforma)" },
  "mgmt.eventCheckbox": {
    English: "Event deposit paid & scheduled during stay",
    Spanish: "Depósito de evento pagado y programado durante la estadía",
    Portuguese: "Depósito de evento pago e agendado durante a estadia",
  },
  "mgmt.pickEventDate": { English: "Pick the event date…", Spanish: "Elige la fecha del evento…", Portuguese: "Escolha a data do evento…" },
  "mgmt.pickTime": { English: "Pick the time…", Spanish: "Elige la hora…", Portuguese: "Escolha o horário…" },
  "mgmt.peopleAttending": { English: "People attending…", Spanish: "Personas asistentes…", Portuguese: "Pessoas presentes…" },
  "mgmt.person": { English: "person", Spanish: "persona", Portuguese: "pessoa" },
  "mgmt.people": { English: "people", Spanish: "personas", Portuguese: "pessoas" },
  "mgmt.event": { English: "EVENT", Spanish: "EVENTO", Portuguese: "EVENTO" },
  "mgmt.notePlaceholder": {
    English: "Add a note (wedding/event, chef booked, early check-in…)",
    Spanish: "Agrega una nota (boda/evento, chef reservado, check-in anticipado…)",
    Portuguese: "Adicione uma nota (casamento/evento, chef reservado, check-in antecipado…)",
  },
  "mgmt.failedEventFlag": {
    English: "Failed to save event flag.",
    Spanish: "No se pudo guardar la marca de evento.",
    Portuguese: "Falha ao salvar a marcação de evento.",
  },
  "mgmt.failedSave": { English: "Failed to save.", Spanish: "No se pudo guardar.", Portuguese: "Falha ao salvar." },
  "mgmt.adult": { English: "adult", Spanish: "adulto", Portuguese: "adulto" },
  "mgmt.adults": { English: "adults", Spanish: "adultos", Portuguese: "adultos" },
  "mgmt.kid": { English: "kid", Spanish: "niño", Portuguese: "criança" },
  "mgmt.kids": { English: "kids", Spanish: "niños", Portuguese: "crianças" },
  "mgmt.night": { English: "night", Spanish: "noche", Portuguese: "noite" },
  "mgmt.nights": { English: "nights", Spanish: "noches", Portuguese: "noites" },

  // ---------- Events list ----------
  "events.title": { English: "Events", Spanish: "Eventos", Portuguese: "Eventos" },
  "events.none": {
    English: 'No events booked yet. Check "Event deposit paid" on a stay to add one.',
    Spanish: 'Aún no hay eventos reservados. Marca "Depósito de evento pagado" en una estadía para agregar uno.',
    Portuguese: 'Ainda não há eventos reservados. Marque "Depósito de evento pago" em uma estadia para adicionar um.',
  },
  "events.dateTbd": { English: "date TBD", Spanish: "fecha por definir", Portuguese: "data a definir" },
  "events.timeTbd": { English: "time TBD", Spanish: "hora por definir", Portuguese: "horário a definir" },
  "events.headcountTbd": { English: "headcount TBD", Spanish: "cantidad por definir", Portuguese: "quantidade a definir" },
  "events.peopleAttending": { English: "people attending", Spanish: "personas asistentes", Portuguese: "pessoas presentes" },
  "events.stay": { English: "Stay", Spanish: "Estadía", Portuguese: "Estadia" },

  // ---------- Transactions hover (admin) ----------
  "tx.balanceOwed": { English: "Balance owed", Spanish: "Saldo pendiente", Portuguese: "Saldo devedor" },
  "tx.paidInFull": { English: "Paid in full", Spanish: "Pagado en su totalidad", Portuguese: "Pago integralmente" },
  "tx.total": { English: "Total", Spanish: "Total", Portuguese: "Total" },
  "tx.paid": { English: "Paid", Spanish: "Pagado", Portuguese: "Pago" },

  // ---------- Countdown badge ----------
  "countdown.toArrival": { English: "to arrival", Spanish: "para la llegada", Portuguese: "para a chegada" },
  "countdown.arrivesToday": { English: "Arrives today", Spanish: "Llega hoy", Portuguese: "Chega hoje" },
  "countdown.inHouse": { English: "In house", Spanish: "En la casa", Portuguese: "Na casa" },
  "countdown.departed": { English: "Departed", Spanish: "Salió", Portuguese: "Partiu" },
  "countdown.day": { English: "day", Spanish: "día", Portuguese: "dia" },
  "countdown.days": { English: "days", Spanish: "días", Portuguese: "dias" },

  // ---------- Team Expense Request ----------
  "exp.title": { English: "Team Expense Request", Spanish: "Solicitud de Gastos del Equipo", Portuguese: "Solicitação de Despesas da Equipe" },
  "exp.subtitle": {
    English:
      "Anyone on the team can ask for money to be spent. The owner approves it, then whoever buys it marks it completed with what it actually cost. Every step records who and when.",
    Spanish:
      "Cualquier miembro del equipo puede solicitar un gasto. El propietario lo aprueba, y quien realice la compra lo marca como completado con el costo real. Cada paso registra quién y cuándo.",
    Portuguese:
      "Qualquer pessoa da equipe pode solicitar um gasto. O proprietário aprova, e quem fizer a compra marca como concluída com o custo real. Cada etapa registra quem e quando.",
  },
  "exp.open": { English: "Open", Spanish: "Abiertas", Portuguese: "Abertas" },
  "exp.completed": { English: "Completed", Spanish: "Completadas", Portuguese: "Concluídas" },
  "exp.waitingOnOwner": { English: "waiting on the owner", Spanish: "esperando al propietario", Portuguese: "aguardando o proprietário" },
  "exp.estimated": { English: "estimated", Spanish: "estimado", Portuguese: "estimado" },
  "exp.requestExpense": { English: "Request an expense", Spanish: "Solicitar un gasto", Portuguese: "Solicitar uma despesa" },
  "exp.editingHelp": {
    English:
      "Editing this request. Saving records who edited it and when — and because the details changed, it goes back to the owner for approval.",
    Spanish:
      "Editando esta solicitud. Al guardar se registra quién la editó y cuándo — y como los detalles cambiaron, vuelve al propietario para su aprobación.",
    Portuguese:
      "Editando esta solicitação. Ao salvar, registra-se quem editou e quando — e como os detalhes mudaram, ela volta para o proprietário aprovar.",
  },
  "exp.newHelp": {
    English:
      "The more detail you give, the faster the owner can approve it. Write in your own language — it's translated automatically.",
    Spanish:
      "Cuanto más detalle des, más rápido podrá aprobarlo el propietario. Escribe en tu propio idioma — se traduce automáticamente.",
    Portuguese:
      "Quanto mais detalhes você der, mais rápido o proprietário poderá aprovar. Escreva no seu próprio idioma — é traduzido automaticamente.",
  },
  "exp.whatDoYouNeed": { English: "What do you need?", Spanish: "¿Qué necesitas?", Portuguese: "O que você precisa?" },
  "exp.whatPlaceholder": {
    English: "New pool pump, gas refill, mattress for room 2…",
    Spanish: "Bomba de piscina nueva, recarga de gas, colchón para habitación 2…",
    Portuguese: "Nova bomba da piscina, recarga de gás, colchão para o quarto 2…",
  },
  "exp.type": { English: "Type", Spanish: "Tipo", Portuguese: "Tipo" },
  "exp.howUrgent": { English: "How urgent?", Spanish: "¿Qué tan urgente?", Portuguese: "Quão urgente?" },
  "exp.urgencyLow": { English: "Low — whenever", Spanish: "Baja — sin prisa", Portuguese: "Baixa — sem pressa" },
  "exp.urgencyNormal": { English: "Normal", Spanish: "Normal", Portuguese: "Normal" },
  "exp.urgencyUrgent": { English: "Urgent — affects guests", Spanish: "Urgente — afecta a los huéspedes", Portuguese: "Urgente — afeta os hóspedes" },
  "exp.whyNeeded": {
    English: "Why is it needed? What exactly should be bought or fixed?",
    Spanish: "¿Por qué se necesita? ¿Qué exactamente debe comprarse o repararse?",
    Portuguese: "Por que é necessário? O que exatamente deve ser comprado ou consertado?",
  },
  "exp.whyPlaceholder": {
    English:
      "The pump has been leaking since Monday, the pool is cloudy and we have guests arriving Friday. Same model as the current one, 1.5 HP.",
    Spanish:
      "La bomba ha estado goteando desde el lunes, la piscina está turbia y tenemos huéspedes llegando el viernes. Mismo modelo que la actual, 1.5 HP.",
    Portuguese:
      "A bomba está vazando desde segunda-feira, a piscina está turva e temos hóspedes chegando na sexta-feira. Mesmo modelo da atual, 1.5 HP.",
  },
  "exp.estimatedCost": { English: "Estimated cost", Spanish: "Costo estimado", Portuguese: "Custo estimado" },
  "exp.currency": { English: "Currency", Spanish: "Moneda", Portuguese: "Moeda" },
  "exp.vendor": { English: "Where / which vendor", Spanish: "Dónde / qué proveedor", Portuguese: "Onde / qual fornecedor" },
  "exp.vendorPlaceholder": {
    English: "Homecenter, local plumber…",
    Spanish: "Homecenter, plomero local…",
    Portuguese: "Homecenter, encanador local…",
  },
  "exp.neededBy": { English: "Needed by", Spanish: "Se necesita antes de", Portuguese: "Necessário até" },
  "exp.referenceLink": { English: "Link to a quote or photo", Spanish: "Enlace a cotización o foto", Portuguese: "Link para orçamento ou foto" },
  "exp.sendRequest": { English: "Send request", Spanish: "Enviar solicitud", Portuguese: "Enviar solicitação" },
  "exp.saveChanges": { English: "Save changes", Spanish: "Guardar cambios", Portuguese: "Salvar alterações" },
  "exp.noOpen": { English: "No open requests right now.", Spanish: "No hay solicitudes abiertas por ahora.", Portuguese: "Nenhuma solicitação aberta no momento." },
  "exp.noCompleted": { English: "Nothing completed yet.", Spanish: "Aún no hay nada completado.", Portuguese: "Ainda não há nada concluído." },
  "exp.urgent": { English: "Urgent", Spanish: "Urgente", Portuguese: "Urgente" },
  "exp.declined": { English: "Declined", Spanish: "Rechazada", Portuguese: "Recusada" },
  "exp.requestedBy": { English: "Requested by", Spanish: "Solicitado por", Portuguese: "Solicitado por" },
  "exp.vendorLabel": { English: "Vendor", Spanish: "Proveedor", Portuguese: "Fornecedor" },
  "exp.quotePhoto": { English: "Quote / photo", Spanish: "Cotización / foto", Portuguese: "Orçamento / foto" },
  "exp.approvedBy": { English: "Approved by", Spanish: "Aprobado por", Portuguese: "Aprovado por" },
  "exp.theOwner": { English: "the owner", Spanish: "el propietario", Portuguese: "o proprietário" },
  "exp.declinedBy": { English: "Declined by", Spanish: "Rechazado por", Portuguese: "Recusado por" },
  "exp.editedBy": { English: "Edited by", Spanish: "Editado por", Portuguese: "Editado por" },
  "exp.aTeammate": { English: "a teammate", Spanish: "un compañero", Portuguese: "um colega" },
  "exp.completedBy": { English: "Completed by", Spanish: "Completado por", Portuguese: "Concluído por" },
  "exp.theTeam": { English: "the team", Spanish: "el equipo", Portuguese: "a equipe" },
  "exp.ownerApproved": { English: "Owner approved", Spanish: "Aprobado por el propietario", Portuguese: "Aprovado pelo proprietário" },
  "exp.needsApprovalFirst": { English: "(needs approval first)", Spanish: "(necesita aprobación primero)", Portuguese: "(precisa de aprovação primeiro)" },
  "exp.decline": { English: "Decline", Spanish: "Rechazar", Portuguese: "Recusar" },
  "exp.couldntSend": { English: "Couldn't send that request.", Spanish: "No se pudo enviar la solicitud.", Portuguese: "Não foi possível enviar a solicitação." },
  "exp.couldntSave": { English: "Couldn't save that.", Spanish: "No se pudo guardar.", Portuguese: "Não foi possível salvar." },
  "exp.costPrompt": {
    English: "actually cost? (leave blank if you don't know yet)",
    Spanish: "costó en realidad? (deja en blanco si aún no lo sabes)",
    Portuguese: "custou de fato? (deixe em branco se ainda não souber)",
  },
  "exp.whatDid": { English: 'What did', Spanish: 'Cuánto', Portuguese: 'Quanto' },
  "exp.declineReasonPrompt": {
    English: "Why are you turning down",
    Spanish: "¿Por qué estás rechazando",
    Portuguese: "Por que você está recusando",
  },
  "exp.optional": { English: "(optional)", Spanish: "(opcional)", Portuguese: "(opcional)" },
  "exp.deleteConfirm": { English: "Delete the request", Spanish: "¿Eliminar la solicitud", Portuguese: "Excluir a solicitação" },
  "exp.loadingRequests": { English: "Loading requests…", Spanish: "Cargando solicitudes…", Portuguese: "Carregando solicitações…" },

  // Category display labels (stored value stays English)
  "cat.Maintenance & repairs": { English: "Maintenance & repairs", Spanish: "Mantenimiento y reparaciones", Portuguese: "Manutenção e reparos" },
  "cat.Cleaning & supplies": { English: "Cleaning & supplies", Spanish: "Limpieza y suministros", Portuguese: "Limpeza e suprimentos" },
  "cat.Guest experience": { English: "Guest experience", Spanish: "Experiencia del huésped", Portuguese: "Experiência do hóspede" },
  "cat.Utilities": { English: "Utilities", Spanish: "Servicios públicos", Portuguese: "Serviços públicos" },
  "cat.Transport & fuel": { English: "Transport & fuel", Spanish: "Transporte y combustible", Portuguese: "Transporte e combustível" },
  "cat.Staff & labor": { English: "Staff & labor", Spanish: "Personal y mano de obra", Portuguese: "Pessoal e mão de obra" },
  "cat.Other": { English: "Other", Spanish: "Otro", Portuguese: "Outro" },

  // ---------- Team Activity Log ----------
  "log.title": { English: "Team Activity Log", Spanish: "Registro de Actividad del Equipo", Portuguese: "Registro de Atividades da Equipe" },
  "log.subtitle": {
    English:
      "Work that isn't tied to one guest — cleaning, repairs, deliveries, supplies. Everyone sees who logged what and when.",
    Spanish:
      "Trabajo que no está ligado a un huésped en particular — limpieza, reparaciones, entregas, suministros. Todos ven quién registró qué y cuándo.",
    Portuguese:
      "Trabalho que não está ligado a um hóspede específico — limpeza, reparos, entregas, suprimentos. Todos veem quem registrou o quê e quando.",
  },
  "log.placeholder": {
    English: "Log what you did (pool cleaned, towels restocked, gas refilled…)",
    Spanish: "Registra lo que hiciste (piscina limpiada, toallas repuestas, gas recargado…)",
    Portuguese: "Registre o que você fez (piscina limpa, toalhas repostas, gás reabastecido…)",
  },
  "log.logIt": { English: "Log it", Spanish: "Registrar", Portuguese: "Registrar" },
  "log.loadingActivity": { English: "Loading activity…", Spanish: "Cargando actividad…", Portuguese: "Carregando atividade…" },
  "log.nothingLogged": { English: "Nothing logged yet.", Spanish: "Aún no hay nada registrado.", Portuguese: "Ainda não há nada registrado." },
  "log.deleteConfirm": { English: "Delete this log entry?", Spanish: "¿Eliminar esta entrada del registro?", Portuguese: "Excluir este registro?" },
  "log.failedDelete": { English: "Failed to delete.", Spanish: "No se pudo eliminar.", Portuguese: "Falha ao excluir." },

  // ---------- Team Requests ----------
  "req.heading": { English: "Requests needing accept or deny", Spanish: "Solicitudes por aceptar o rechazar", Portuguese: "Solicitações a aceitar ou recusar" },
  "req.subtext": {
    English: "Tag a teammate to approve something — they're notified on WhatsApp and email.",
    Spanish: "Etiqueta a un compañero para que apruebe algo — se le notifica por WhatsApp y correo.",
    Portuguese: "Marque um colega para aprovar algo — ele é notificado por WhatsApp e e-mail.",
  },
  "req.newRequest": { English: "New request", Spanish: "Nueva solicitud", Portuguese: "Nova solicitação" },
  "req.titlePlaceholder": {
    English: 'What do you need? (e.g. "Tour guide for Aug 25 group")',
    Spanish: '¿Qué necesitas? (ej. "Guía turístico para el grupo del 25 de agosto")',
    Portuguese: 'O que você precisa? (ex. "Guia turístico para o grupo de 25 de agosto")',
  },
  "req.detailsPlaceholder": {
    English: "Any details they should know (optional)",
    Spanish: "Algún detalle que deban saber (opcional)",
    Portuguese: "Algum detalhe que precisem saber (opcional)",
  },
  "req.neededBy": { English: "Needed by", Spanish: "Se necesita antes de", Portuguese: "Necessário até" },
  "req.tagSomeone": { English: "Tag someone to decide", Spanish: "Etiqueta a alguien para decidir", Portuguese: "Marque alguém para decidir" },
  "req.choose": { English: "Choose…", Spanish: "Elegir…", Portuguese: "Escolher…" },
  "req.you": { English: "(you)", Spanish: "(tú)", Portuguese: "(você)" },
  "req.sendRequest": { English: "Send request", Spanish: "Enviar solicitud", Portuguese: "Enviar solicitação" },
  "req.sending": { English: "Sending…", Spanish: "Enviando…", Portuguese: "Enviando…" },
  "req.noRequestsYet": { English: "No requests yet.", Spanish: "Aún no hay solicitudes.", Portuguese: "Ainda não há solicitações." },
  "req.statusCompleted": { English: "Completed", Spanish: "Completada", Portuguese: "Concluída" },
  "req.statusDeclined": { English: "Declined", Spanish: "Rechazada", Portuguese: "Recusada" },
  "req.statusAccepted": { English: "Accepted", Spanish: "Aceptada", Portuguese: "Aceita" },
  "req.statusAwaiting": { English: "Awaiting decision", Spanish: "Esperando decisión", Portuguese: "Aguardando decisão" },
  "req.neededByInline": { English: "needed by", Spanish: "se necesita antes de", Portuguese: "necessário até" },
  "req.tagged": { English: "tagged", Spanish: "etiquetó a", Portuguese: "marcou" },
  "req.accepted": { English: "accepted", Spanish: "aceptó", Portuguese: "aceitou" },
  "req.declined": { English: "declined", Spanish: "rechazó", Portuguese: "recusou" },
  "req.by": { English: "by", Spanish: "por", Portuguese: "por" },
  "req.completedBy": { English: "completed by", Spanish: "completado por", Portuguese: "concluído por" },
  "req.accept": { English: "Accept", Spanish: "Aceptar", Portuguese: "Aceitar" },
  "req.deny": { English: "Deny", Spanish: "Rechazar", Portuguese: "Recusar" },
  "req.markCompleted": { English: "Mark completed", Spanish: "Marcar como completada", Portuguese: "Marcar como concluída" },
  "req.undoCompleted": { English: "Undo completed", Spanish: "Deshacer completado", Portuguese: "Desfazer conclusão" },
  "req.addNotePlaceholder": { English: "Add a note…", Spanish: "Agrega una nota…", Portuguese: "Adicione uma nota…" },
  "req.reasonPrompt": { English: "Reason (optional):", Spanish: "Motivo (opcional):", Portuguese: "Motivo (opcional):" },
  "req.removeConfirm": { English: "Remove this request?", Spanish: "¿Quitar esta solicitud?", Portuguese: "Remover esta solicitação?" },

  // ---------- Settings (restricted / team) ----------
  "settings.title": { English: "Settings", Spanish: "Configuración", Portuguese: "Configurações" },
  "settings.restrictedSubtitle": {
    English: "Account connections are managed by the property owner. Here's what you can change.",
    Spanish: "Las conexiones de la cuenta las gestiona el propietario. Esto es lo que puedes cambiar.",
    Portuguese: "As conexões da conta são gerenciadas pelo proprietário. Aqui está o que você pode alterar.",
  },
  "settings.changePassword": { English: "Change your password →", Spanish: "Cambiar tu contraseña →", Portuguese: "Alterar sua senha →" },
  "settings.changePasswordHint": {
    English: "Set a new password for your own login.",
    Spanish: "Establece una nueva contraseña para tu propio inicio de sesión.",
    Portuguese: "Defina uma nova senha para o seu próprio login.",
  },

  // ---------- My Account ----------
  "account.title": { English: "My Account", Spanish: "Mi Cuenta", Portuguese: "Minha Conta" },
  "account.subtitle": { English: "Your own login details.", Spanish: "Los datos de tu propio inicio de sesión.", Portuguese: "Os dados do seu próprio login." },
  "account.signedInAs": { English: "Signed in as", Spanish: "Sesión iniciada como", Portuguese: "Conectado como" },
  "account.access": { English: "Access", Spanish: "Acceso", Portuguese: "Acesso" },
  "account.adminFull": { English: "Admin (full access)", Spanish: "Administrador (acceso completo)", Portuguese: "Administrador (acesso total)" },
  "account.teamViewOnly": { English: "Team member (view only)", Spanish: "Miembro del equipo (solo lectura)", Portuguese: "Membro da equipe (somente leitura)" },
  "account.properties": { English: "Properties", Spanish: "Propiedades", Portuguese: "Propriedades" },
  "account.language": { English: "Language", Spanish: "Idioma", Portuguese: "Idioma" },
  "account.changePassword": { English: "Change your password", Spanish: "Cambiar tu contraseña", Portuguese: "Alterar sua senha" },

  // ---------- Change password form ----------
  "pw.helper": {
    English: "Pick something only you know — at least 8 characters. You'll use the new password the next time you sign in.",
    Spanish: "Elige algo que solo tú sepas — al menos 8 caracteres. Usarás la nueva contraseña la próxima vez que inicies sesión.",
    Portuguese: "Escolha algo que só você saiba — pelo menos 8 caracteres. Você usará a nova senha na próxima vez que entrar.",
  },
  "pw.current": { English: "Current password", Spanish: "Contraseña actual", Portuguese: "Senha atual" },
  "pw.new": { English: "New password", Spanish: "Nueva contraseña", Portuguese: "Nova senha" },
  "pw.repeat": { English: "Repeat new password", Spanish: "Repetir nueva contraseña", Portuguese: "Repetir nova senha" },
  "pw.saveNew": { English: "Save new password", Spanish: "Guardar nueva contraseña", Portuguese: "Salvar nova senha" },
  "pw.mismatch": { English: "The two new passwords don't match.", Spanish: "Las dos contraseñas nuevas no coinciden.", Portuguese: "As duas novas senhas não coincidem." },
  "pw.success": {
    English: "Password changed. Use the new one next time you sign in.",
    Spanish: "Contraseña cambiada. Usa la nueva la próxima vez que inicies sesión.",
    Portuguese: "Senha alterada. Use a nova na próxima vez que entrar.",
  },
  "pw.couldntChange": { English: "Couldn't change the password.", Spanish: "No se pudo cambiar la contraseña.", Portuguese: "Não foi possível alterar a senha." },

  // ---------- Commissions ----------
  "comm.title": { English: "Commissions", Spanish: "Comisiones", Portuguese: "Comissões" },
  "comm.subtitle": {
    English: "Extras commission and direct-booking referrals — approved by the owner, settled in COP.",
    Spanish: "Comisión de extras y referidos de reserva directa — aprobados por el propietario, liquidados en COP.",
    Portuguese: "Comissão de extras e indicações de reserva direta — aprovadas pelo proprietário, liquidadas em COP.",
  },
  "comm.notEnabled": {
    English: "Commissions are only tracked for Legacy Colombia. Switch properties to see this tab.",
    Spanish: "Las comisiones solo se registran para Legacy Colombia. Cambia de propiedad para ver esta pestaña.",
    Portuguese: "As comissões só são registradas para Legacy Colombia. Troque de propriedade para ver esta aba.",
  },
  "comm.owedToGabriel": { English: "Owed to Gabriel (approved)", Spanish: "Debido a Gabriel (aprobado)", Portuguese: "Devido a Gabriel (aprovado)" },
  "comm.awaitingApproval": { English: "Awaiting your approval", Spanish: "Esperando tu aprobación", Portuguese: "Aguardando sua aprovação" },
  "comm.pendingReview": { English: "Awaiting owner review", Spanish: "Esperando revisión del propietario", Portuguese: "Aguardando revisão do proprietário" },
  "comm.approvedLocked": { English: "Approved — locked", Spanish: "Aprobado — bloqueado", Portuguese: "Aprovado — bloqueado" },
  "comm.declinedLine": { English: "Declined", Spanish: "Rechazado", Portuguese: "Recusado" },
  "comm.extraType": { English: "Extra", Spanish: "Extra", Portuguese: "Extra" },
  "comm.directBooking": { English: "Direct booking", Spanish: "Reserva directa", Portuguese: "Reserva direta" },
  "comm.guest": { English: "Guest", Spanish: "Huésped", Portuguese: "Hóspede" },
  "comm.total": { English: "Total", Spanish: "Total", Portuguese: "Total" },
  "comm.house": { English: "House", Spanish: "Casa", Portuguese: "Casa" },
  "comm.gabriel": { English: "Gabriel", Spanish: "Gabriel", Portuguese: "Gabriel" },
  "comm.approve": { English: "Approve", Spanish: "Aprobar", Portuguese: "Aprovar" },
  "comm.decline": { English: "Decline", Spanish: "Rechazar", Portuguese: "Recusar" },
  "comm.declineReasonPrompt": { English: "Reason (optional):", Spanish: "Motivo (opcional):", Portuguese: "Motivo (opcional):" },
  "comm.noPending": { English: "Nothing awaiting approval.", Spanish: "Nada en espera de aprobación.", Portuguese: "Nada aguardando aprovação." },
  "comm.noApproved": { English: "Nothing approved and unpaid right now.", Spanish: "Nada aprobado y sin pagar por ahora.", Portuguese: "Nada aprovado e não pago no momento." },
  "comm.settlePayout": { English: "Settle payout", Spanish: "Liquidar pago", Portuguese: "Liquidar pagamento" },
  "comm.settleTitle": { English: "Settle Gabriel's payout", Spanish: "Liquidar el pago de Gabriel", Portuguese: "Liquidar o pagamento de Gabriel" },
  "comm.settleHelp": {
    English: "Marks every approved, unpaid line above as paid. Record this once you've actually handed over the cash.",
    Spanish: "Marca cada línea aprobada y sin pagar como pagada. Regístralo una vez que hayas entregado el efectivo.",
    Portuguese: "Marca cada linha aprovada e não paga como paga. Registre isso depois de entregar o dinheiro.",
  },
  "comm.liveRate": { English: "Live rate", Spanish: "Tasa en vivo", Portuguese: "Taxa ao vivo" },
  "comm.buffer": { English: "Buffer %", Spanish: "Margen %", Portuguese: "Margem %" },
  "comm.effectiveRate": { English: "Effective rate", Spanish: "Tasa efectiva", Portuguese: "Taxa efetiva" },
  "comm.totalCop": { English: "Total COP to hand over", Spanish: "Total COP a entregar", Portuguese: "Total COP a entregar" },
  "comm.noteOptional": { English: "Note (optional)", Spanish: "Nota (opcional)", Portuguese: "Nota (opcional)" },
  "comm.confirmSettle": { English: "Confirm — mark as paid", Spanish: "Confirmar — marcar como pagado", Portuguese: "Confirmar — marcar como pago" },
  "comm.settling": { English: "Settling…", Spanish: "Liquidando…", Portuguese: "Liquidando…" },
  "comm.settlementHistory": { English: "Settlement history", Spanish: "Historial de liquidaciones", Portuguese: "Histórico de liquidações" },
  "comm.noSettlements": { English: "No settlements yet.", Spanish: "Aún no hay liquidaciones.", Portuguese: "Ainda não há liquidações." },
  "comm.settledBy": { English: "Settled by", Spanish: "Liquidado por", Portuguese: "Liquidado por" },
  "comm.rateUsed": { English: "rate used", Spanish: "tasa usada", Portuguese: "taxa usada" },
  "comm.couldntLoad": { English: "Couldn't load commissions.", Spanish: "No se pudieron cargar las comisiones.", Portuguese: "Não foi possível carregar as comissões." },
  "comm.couldntSave": { English: "Couldn't save that.", Spanish: "No se pudo guardar.", Portuguese: "Não foi possível salvar." },
  "comm.viewOnlyNote": {
    English: "Only the owner can approve or settle these — you're viewing.",
    Spanish: "Solo el propietario puede aprobar o liquidar esto — estás viendo.",
    Portuguese: "Somente o proprietário pode aprovar ou liquidar isso — você está visualizando.",
  },
  "comm.loading": { English: "Loading commissions…", Spanish: "Cargando comisiones…", Portuguese: "Carregando comissões…" },
  "comm.logExtra": { English: "Log an extra", Spanish: "Registrar un extra", Portuguese: "Registrar um extra" },
  "comm.editExtraLine": { English: "Edit extra", Spanish: "Editar extra", Portuguese: "Editar extra" },
  "comm.selectStay": { English: "Which stay?", Spanish: "¿Qué estadía?", Portuguese: "Qual estadia?" },
  "comm.chooseStay": { English: "Choose a stay…", Spanish: "Elige una estadía…", Portuguese: "Escolha uma estadia…" },
  "comm.noStays": { English: "No stays found for this property.", Spanish: "No se encontraron estadías para esta propiedad.", Portuguese: "Nenhuma estadia encontrada para esta propriedade." },
  "comm.kind": { English: "Type", Spanish: "Tipo", Portuguese: "Tipo" },
  "comm.describeExtra": { English: "Describe the extra", Spanish: "Describe el extra", Portuguese: "Descreva o extra" },
  "comm.serviceDateField": { English: "Date (defaults to arrival)", Spanish: "Fecha (por defecto la llegada)", Portuguese: "Data (padrão: chegada)" },
  "comm.guestPaidField": { English: "Guest paid", Spanish: "Pagó el huésped", Portuguese: "Hóspede pagou" },
  "comm.vendorPaidField": { English: "Paid to vendor", Spanish: "Pagado al proveedor", Portuguese: "Pago ao fornecedor" },
  "comm.notesField": { English: "Notes (optional)", Spanish: "Notas (opcional)", Portuguese: "Notas (opcional)" },
  "comm.saveExtra": { English: "Save extra", Spanish: "Guardar extra", Portuguese: "Salvar extra" },
  "comm.markSettled": { English: "Settled", Spanish: "Liquidado", Portuguese: "Liquidado" },
  "comm.settleThisLine": { English: "Settle this line", Spanish: "Liquidar esta línea", Portuguese: "Liquidar esta linha" },
  "comm.alreadyPaidHelp": {
    English: "For when Gabriel already collected this in cash — marks it paid and logs it to settlement history.",
    Spanish: "Para cuando Gabriel ya cobró esto en efectivo — lo marca como pagado y lo registra en el historial de liquidaciones.",
    Portuguese: "Para quando Gabriel já recebeu isso em dinheiro — marca como pago e registra no histórico de liquidações.",
  },
};

/** Every valid translation key — for editor autocomplete on call sites that
 * use a literal. Call sites that build a key dynamically (e.g. NavBar's
 * label lookup) just pass `string`, which the loose signature below still
 * accepts — an unknown key falls back to itself rather than erroring. */
export type StringKey = keyof typeof STRINGS;

/** Static string lookup. Falls back to English, then to the key itself if
 * a translation is somehow missing or unrecognized (never silently blank,
 * never throws on a dynamically-built key). */
export function t(key: string, lang?: string | null): string {
  const entry = STRINGS[key as StringKey];
  if (!entry) return key;
  const l = normalizeLang(lang);
  return entry[l] || entry.English || key;
}

/** Category display label for Team Expense Request — the underlying stored
 * value (sent to the API, used for filtering) always stays the English
 * constant from TeamExpenseRequests.tsx's CATEGORIES list. */
export function categoryLabel(value: string, lang?: string | null): string {
  const key = `cat.${value}`;
  return STRINGS[key as StringKey] ? t(key, lang) : value;
}

/** Booking status display label (OwnerRez's own status strings — Booked,
 * Checked In, etc.). Display only; never used for comparisons/filtering. */
export function statusLabel(value: string, lang?: string | null): string {
  const key = `status.${value}`;
  return STRINGS[key as StringKey] ? t(key, lang) : value;
}

/** Picks singular vs. plural translated noun for n===1 vs n!==1 — every
 * noun in this dashboard's UI (nights, adults, kids, people, days) pluralizes
 * regularly in English/Spanish/Portuguese by swapping the whole word, so one
 * helper covers all of them. */
export function plural(n: number, singularKey: string, pluralKey: string, lang?: string | null): string {
  return t(n === 1 ? singularKey : pluralKey, lang);
}
