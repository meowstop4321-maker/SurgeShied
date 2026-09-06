// Calendar helper: Generates Google Calendar links and downloadable .ics files

export interface CalendarEvent {
  title: string;
  description: string;
  location?: string;
  startsAt: string; // ISO string
  endsAt?: string;  // ISO string
}

function formatDateToICS(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toISOString().replace(/-|:|\.\d\d\d/g, "");
}

export function createGoogleCalendarUrl(event: CalendarEvent): string {
  const startFormatted = formatDateToICS(event.startsAt);
  const endFormatted = event.endsAt
    ? formatDateToICS(event.endsAt)
    : formatDateToICS(new Date(new Date(event.startsAt).getTime() + 2 * 60 * 60 * 1000).toISOString());

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: `${startFormatted}/${endFormatted}`,
    details: event.description,
    location: event.location || "Online",
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function downloadICSFile(event: CalendarEvent): void {
  const startFormatted = formatDateToICS(event.startsAt);
  const endFormatted = event.endsAt
    ? formatDateToICS(event.endsAt)
    : formatDateToICS(new Date(new Date(event.startsAt).getTime() + 2 * 60 * 60 * 1000).toISOString());

  const icsContent = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//SurgeShield//Event Registration//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `SUMMARY:${event.title}`,
    `DESCRIPTION:${event.description.replace(/\n/g, "\\n")}`,
    `LOCATION:${event.location || "Online"}`,
    `DTSTART:${startFormatted}`,
    `DTEND:${endFormatted}`,
    `UID:${crypto.randomUUID()}@surgeshield.dev`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const blob = new Blob([icsContent], { type: "text/calendar;charset=utf-8" });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", `${event.title.replace(/[^a-z0-9]/gi, "_").toLowerCase()}.ics`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
