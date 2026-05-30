import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ensureAuthorized } from "../auth.js";

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const attendeeSchema = z.object({
  email: z.string(),
  optional: z.boolean().optional(),
  responseStatus: z.enum(["needsAction", "declined", "tentative", "accepted"]).optional(),
});

const eventTimeSchema = z.object({
  dateTime: z.string().optional().describe("RFC3339 e.g. 2026-05-21T14:00:00-07:00"),
  date: z.string().optional().describe("YYYY-MM-DD for all-day"),
  timeZone: z.string().optional(),
});

export function registerCalendarTools(server: McpServer, auth: OAuth2Client): void {
  const calendar = google.calendar({ version: "v3", auth });

  server.tool(
    "calendar_list_calendars",
    "List the user's calendars.",
    {},
    async () => {
      ensureAuthorized();
      const res = await calendar.calendarList.list({});
      return asText(res.data.items ?? []);
    },
  );

  server.tool(
    "calendar_list_events",
    "List events on a calendar in a time window. Default calendar_id is 'primary'.",
    {
      calendar_id: z.string().optional(),
      time_min: z.string().optional().describe("RFC3339; default = now"),
      time_max: z.string().optional().describe("RFC3339"),
      query: z.string().optional().describe("Free-text search"),
      max_results: z.number().int().min(1).max(2500).optional(),
      page_token: z.string().optional(),
      single_events: z.boolean().optional().describe("Default true: expand recurring"),
    },
    async ({ calendar_id, time_min, time_max, query, max_results, page_token, single_events }) => {
      ensureAuthorized();
      const res = await calendar.events.list({
        calendarId: calendar_id ?? "primary",
        timeMin: time_min ?? new Date().toISOString(),
        timeMax: time_max,
        q: query,
        maxResults: max_results ?? 25,
        pageToken: page_token,
        singleEvents: single_events ?? true,
        orderBy: (single_events ?? true) ? "startTime" : undefined,
      });
      return asText({
        events: res.data.items ?? [],
        nextPageToken: res.data.nextPageToken ?? null,
      });
    },
  );

  server.tool(
    "calendar_get_event",
    "Fetch a single event.",
    {
      calendar_id: z.string().optional(),
      event_id: z.string(),
    },
    async ({ calendar_id, event_id }) => {
      ensureAuthorized();
      const res = await calendar.events.get({
        calendarId: calendar_id ?? "primary",
        eventId: event_id,
      });
      return asText(res.data);
    },
  );

  server.tool(
    "calendar_create_event",
    "Create a calendar event. Provide either dateTime+timeZone for timed events or date for all-day.",
    {
      calendar_id: z.string().optional(),
      summary: z.string(),
      description: z.string().optional(),
      location: z.string().optional(),
      start: eventTimeSchema,
      end: eventTimeSchema,
      attendees: z.array(attendeeSchema).optional(),
      send_updates: z.enum(["all", "externalOnly", "none"]).optional(),
    },
    async ({ calendar_id, summary, description, location, start, end, attendees, send_updates }) => {
      ensureAuthorized();
      const res = await calendar.events.insert({
        calendarId: calendar_id ?? "primary",
        sendUpdates: send_updates ?? "none",
        requestBody: { summary, description, location, start, end, attendees },
      });
      return asText(res.data);
    },
  );

  server.tool(
    "calendar_update_event",
    "Patch an existing event. Only provided fields are updated.",
    {
      calendar_id: z.string().optional(),
      event_id: z.string(),
      summary: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      start: eventTimeSchema.optional(),
      end: eventTimeSchema.optional(),
      attendees: z.array(attendeeSchema).optional(),
      send_updates: z.enum(["all", "externalOnly", "none"]).optional(),
    },
    async ({ calendar_id, event_id, send_updates, ...patch }) => {
      ensureAuthorized();
      const res = await calendar.events.patch({
        calendarId: calendar_id ?? "primary",
        eventId: event_id,
        sendUpdates: send_updates ?? "none",
        requestBody: patch,
      });
      return asText(res.data);
    },
  );

  server.tool(
    "calendar_delete_event",
    "Delete an event.",
    {
      calendar_id: z.string().optional(),
      event_id: z.string(),
      send_updates: z.enum(["all", "externalOnly", "none"]).optional(),
    },
    async ({ calendar_id, event_id, send_updates }) => {
      ensureAuthorized();
      await calendar.events.delete({
        calendarId: calendar_id ?? "primary",
        eventId: event_id,
        sendUpdates: send_updates ?? "none",
      });
      return asText({ ok: true, deleted: event_id });
    },
  );
}
